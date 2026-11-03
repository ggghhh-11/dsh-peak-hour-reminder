/**
 * dsh-peak-hour-reminder host plugin.
 *
 * 1. At the first step of a turn that starts during peak, append a visible
 *    `notice` with the current Beijing time, peak window, and time to off-peak.
 * 2. When a turn starts off-peak and reaches peak mid-turn, pause at the next
 *    safe pre-step boundary and ask the user whether to continue. Continue
 *    resumes the step; pause rejects the next step and leaves the durable
 *    session history intact.
 * 3. Refresh the holiday store when the current year is beyond its coverage,
 *    prune stale years, and fall back to weekday rules when refresh fails.
 */

import { randomUUID } from 'node:crypto'
import { normalizeConfig, resolvePeakState, formatReminder, getDateParts, truncateSummary } from './peak.js'
import { loadData, saveData, pruneData, needsUpdate, targetYears, dataIncomplete, refreshDueAt } from './data.js'
import { refreshHolidayData } from './update.js'
import {
  createTurnState,
  shouldAskPause,
  hasClaimedInput,
  answerMeansContinue,
  formatPauseQuestion,
  formatPauseNotice,
  formatContinueNotice,
  formatOffPeakAfterWaitNotice,
} from './pause.js'

export const name = 'dsh-peak-hour-reminder'
export const inject = ['agents', 'userQuestions']

const SOURCE_KIND = 'plugin:dsh-peak-hour-reminder'

function nowFor(config) {
  return config.debugNow ? new Date(config.debugNow) : new Date()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Wait at most `ms` for a refresh that may already be running in the background. */
function raceWithTimeout(promise, ms, fallback) {
  if (!Number.isInteger(ms) || ms <= 0) return promise
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms)
      timer.unref?.()
    }),
  ])
}

function noticeMessage(text, summary = truncateSummary(text)) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary,
    },
  }
}

export function apply(ctx, rawConfig = {}, deps = {}) {
  const { config, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) console.warn(`[peak-hour-reminder] ${warning}`)
  if (config.enabled === false) return

  const warned = new Set()
  const warnOnce = (key, error) => {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(`[peak-hour-reminder] ${key}: ${errorText(error)}`)
  }

  let data
  try {
    data = deps.data ?? loadData(config)
  } catch (error) {
    warnOnce('load', error)
    data = { schemaVersion: 1, updatedAt: null, coverageThrough: null, years: {}, lastAttemptAt: null, nextCheckAt: null, lastError: null }
  }

  const nowProvider = () => {
    const value = typeof deps.now === 'function' ? deps.now() : nowFor(config)
    return value instanceof Date ? value : new Date(value)
  }

  const initialYear = getDateParts(nowProvider(), config.timeZone).year
  const removed = pruneData(data, initialYear, config.retentionYears)
  if (removed.length > 0) {
    console.log(`[peak-hour-reminder] pruned stale holiday years: ${removed.join(', ')}`)
    if (deps.data === undefined) {
      try {
        saveData(config, data)
      } catch (error) {
        warnOnce('save-prune', error)
      }
    }
  }

  let refreshPromise = null

  const shouldRefresh = (nowMs = Date.now()) => {
    if (config.updateEnabled !== true) return false
    const parts = getDateParts(nowProvider(), config.timeZone)
    if (!needsUpdate(data, parts)) return false
    if (config.debugForceUpdate === true) return true
    return refreshDueAt(data, nowMs)
  }

  const runRefresh = (maxWaitMs = 0) => {
    if (config.updateEnabled !== true) return Promise.resolve(data)
    if (refreshPromise !== null) return refreshPromise
    const controller = new AbortController()
    let timer
    if (Number.isInteger(maxWaitMs) && maxWaitMs > 0) {
      timer = setTimeout(() => controller.abort(new Error('holiday refresh deadline exceeded')), maxWaitMs)
      timer.unref?.()
    }
    const now = nowProvider()
    const parts = getDateParts(now, config.timeZone)
    const years = targetYears(data, parts)
    if (years.length === 0) {
      clearTimeout(timer)
      return Promise.resolve(data)
    }
    refreshPromise = (async () => {
      try {
        const result = await refreshHolidayData({
          data,
          years,
          config,
          fetchImpl: deps.fetchImpl,
          signal: controller.signal,
          now,
        })
        data = result.data
        if (result.changed) console.log(`[peak-hour-reminder] holiday data updated for ${years.join(', ')}`)
        if (result.saveError) warnOnce('save-refresh', result.saveError)
        const firstError = result.results.find((entry) => entry.status === 'error')
        if (firstError) warnOnce('refresh-error', firstError.error)
        return data
      } catch (error) {
        warnOnce('refresh', error)
        return data
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        refreshPromise = null
      }
    })()
    return refreshPromise
  }

  if (shouldRefresh()) void runRefresh()

  if (config.updateEnabled === true && deps.disableTimers !== true) {
    try {
      ctx.effect(() => {
        const interval = setInterval(() => {
          if (shouldRefresh()) void runRefresh()
        }, config.updateCheckIntervalMinutes * 60 * 1000)
        interval.unref?.()
        return () => clearInterval(interval)
      }, 'dsh-peak-hour-reminder: refresh timer')
    } catch (error) {
      warnOnce('timer', error)
    }
  }

  const turns = new WeakMap()
  const notified = new WeakMap()

  const appendPauseNotice = (agent) => {
    const text = formatPauseNotice()
    try {
      if (typeof agent?.session?.append !== 'function') return
      agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' })
    } catch (error) {
      warnOnce('append-pause', error)
    }
  }

  const withNotice = (decision, value) => {
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
    const text = typeof value === 'string' ? value : value.text
    const summary = typeof value === 'string' ? truncateSummary(value) : value.summary
    return {
      ...decision,
      messages: [...(Array.isArray(decision.messages) ? decision.messages : []), noticeMessage(text, summary)],
    }
  }

  const askPause = async ({ agent, turnState, state, decision, signal }) => {
    const service = deps.userQuestions ?? ctx.userQuestions
    let answer
    try {
      if (service === null || typeof service?.ask !== 'function') {
        const error = new Error('no userQuestions service available')
        error.code = 'NO_PROVIDER'
        throw error
      }
      answer = await service.ask({
        agent,
        ...(signal === undefined ? {} : { signal }),
        questions: [formatPauseQuestion(state, config)],
      })
    } catch (error) {
      if (error?.code === 'ASK_ABORTED') return { kind: 'reject' }
      warnOnce('pause-ask', error)
      appendPauseNotice(agent)
      return { kind: 'reject' }
    }

    const after = resolvePeakState(nowProvider(), config, data)
    if (!after.peak) {
      return withNotice(decision, formatOffPeakAfterWaitNotice(after, config))
    }
    if (answerMeansContinue(answer)) {
      turnState.acceptedWindowKey = state.windowKey
      return withNotice(decision, formatContinueNotice(state, config))
    }
    appendPauseNotice(agent)
    return { kind: 'reject' }
  }

  const onPreStep = async (payload, next) => {
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object') return decision
      if (decision.kind === 'reject') return decision
      const { agent, turn, step, signal } = payload ?? {}
      if (agent === undefined || agent === null) return decision
      if (!Number.isInteger(step) || step < 1) return decision
      if (signal?.aborted === true) return decision
      if (agent.session?.header?.origin === 'subagent') return decision

      if (step === 1 && config.updateEnabled === true && shouldRefresh()) {
        await raceWithTimeout(runRefresh(config.blockingUpdateMs), config.blockingUpdateMs, data)
      }

      const now = nowProvider()
      const state = resolvePeakState(now, config, data)

      if (step === 1) {
        const forcedPauseDemo = config.debugForcePause === true
        turns.set(agent, createTurnState({ turn, startedPeak: forcedPauseDemo ? false : state.peak }))
        if (!forcedPauseDemo && state.peak && notified.get(agent) !== turn) {
          notified.set(agent, turn)
          const incompleteYear = dataIncomplete(data, state.year) ? state.year : null
          return withNotice(decision, formatReminder(state, config, { incompleteYear }))
        }
        return decision
      }

      let turnState = turns.get(agent)
      if (turnState === undefined || turnState.turn !== turn) {
        turns.set(agent, createTurnState({ turn, startedPeak: state.peak }))
        return decision
      }
      if (config.pauseOnPeakCrossing !== true) return decision
      const ask = shouldAskPause(turnState, {
        step,
        nowPeak: state.peak,
        windowKey: state.windowKey,
        hasClaimedInput: hasClaimedInput(decision.messages),
      })
      if (!ask) return decision
      return await askPause({ agent, turnState, state, decision, signal })
    } catch (error) {
      warnOnce('pre-step', error)
      return decision
    }
  }

  try {
    ctx.on('agent/pre-step', onPreStep)
  } catch (error) {
    warnOnce('register', error)
  }
}
