/**
 * Cross-peak pause state machine and question/notice text.
 *
 * The pause happens at a pre-step boundary, never inside an in-flight model
 * stream or tool call: completed steps are already durable, so stopping before
 * the next step saves exactly the progress that exists.
 */

import { timeZoneLabel, truncateSummary } from './peak.js'

const QUESTION_ID = 'peak-crossing'

/** Create one turn's pause state. */
export function createTurnState({ turn, startedPeak }) {
  return {
    turn,
    startedPeak: startedPeak === true,
    acceptedWindowKey: null,
  }
}

/**
 * True when `messages` carries real input that must not be discarded by a
 * reject. Runtime-context messages are generated on every step and do not
 * count as user input.
 */
export function hasClaimedInput(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    if (message === null || typeof message !== 'object') return true
    return message.source?.kind !== 'runtime-context'
  })
}

/**
 * Whether this pre-step should ask the user before continuing.
 * Only after step 1 (rejecting step 1 would discard the user's input), only
 * for turns that started off-peak, only while peak, once per peak window.
 */
export function shouldAskPause(state, { step, nowPeak, windowKey, hasClaimedInput: claimedInput }) {
  if (state === null || typeof state !== 'object') return false
  if (!Number.isInteger(step) || step < 2) return false
  if (state.startedPeak === true) return false
  if (nowPeak !== true) return false
  if (typeof windowKey !== 'string' || windowKey.length === 0) return false
  if (state.acceptedWindowKey === windowKey) return false
  if (claimedInput === true) return false
  return true
}

/** Interpret the userQuestions answer. Only an explicit "continue" continues. */
export function answerMeansContinue(answer) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  if (answers.length === 0) return false
  const item = answers.find((entry) => entry?.id === QUESTION_ID) ?? answers[0]
  if (item === null || typeof item !== 'object') return false
  const selected = Array.isArray(item.selected) ? item.selected.filter((value) => typeof value === 'string') : []
  if (selected.some((value) => value.includes('暂停') || /stop|cancel/i.test(value))) return false
  if (selected.some((value) => value.includes('继续') || /continue/i.test(value))) return true
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  if (custom.length === 0) return false
  if (custom.includes('暂停') || custom.includes('不') || /stop|cancel/i.test(custom)) return false
  return custom.includes('继续') || /continue/i.test(custom)
}

/** The blocking question object passed to ctx.userQuestions.ask. */
export function formatPauseQuestion(state, config) {
  const zone = timeZoneLabel(config?.timeZone ?? 'Asia/Shanghai')
  const label = state?.window ? `${state.window.start}–${state.window.end}` : '高峰时段'
  return {
    id: QUESTION_ID,
    header: '已进入高峰时段',
    question: `本轮从空闲时段开始，执行过程中进入模型调用高峰时段（${label}，${zone}）。当前进度已保存，是否继续执行后续步骤？`,
    detail: '选择「暂停」会结束本轮后续步骤，进度保留；之后发送「继续」即可恢复。选择「继续」将按高峰价计费。',
    options: [
      { label: '继续', description: '继续执行后续步骤；按高峰价计费' },
      { label: '暂停', description: '停止后续步骤，进度保留；稍后发送「继续」恢复' },
    ],
  }
}

/** Notice persisted when the user chooses pause (or no answerer exists). */
export function formatPauseNotice() {
  return '⏸ 已在高峰时段暂停后续步骤（当前进度已保存）。发送「继续」即可恢复。'
}

/** Notice added to the next step when the user chooses continue. */
export function formatContinueNotice(state, config) {
  const zone = timeZoneLabel(config?.timeZone ?? 'Asia/Shanghai')
  const label = state?.window ? `${state.window.start}–${state.window.end}` : '高峰时段'
  return `⏰ 已进入高峰时段（${label}，${zone}），用户选择继续执行。`
}

/** Notice added when the user waited until the peak window ended. */
export function formatOffPeakAfterWaitNotice(state, config) {
  const zone = timeZoneLabel(config?.timeZone ?? 'Asia/Shanghai')
  return `☕ 高峰时段已结束（现在是${state?.weekday ?? ''} ${state?.timeText ?? ''}，${zone}），继续执行。`
}

/** One-line notice summary (the GUI shows this in its collapsed row). */
export function pauseNoticeSummary(text = formatPauseNotice()) {
  return truncateSummary(text)
}

export { QUESTION_ID }
