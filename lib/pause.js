/**
 * Cross-peak pause state machine and question/notice text.
 *
 * The pause happens at a pre-step boundary, never inside an in-flight model
 * stream or tool call: completed steps are already durable, so stopping before
 * the next step saves exactly the progress that exists.
 */

import { timeZoneLabel, formatDuration, truncateSummary } from './peak.js'

const QUESTION_ID = 'peak-crossing'
const PEAK_START_QUESTION_ID = 'peak-start'

/** Create one turn's pause state. */
export function createTurnState({ turn, startedPeak }) {
  return {
    turn,
    startedPeak: startedPeak === true,
  }
}

/** Whether the claimed batch contains a real human message. */
export function hasHumanMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message?.role === 'user' && message?.source?.kind === 'user')
}

/** Text of the first human message in the claimed batch (for resume detection). */
export function firstHumanText(messages) {
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

/** Whether a user message is an explicit resume instruction (继续 / continue / resume). */
export function isResumeIntent(text) {
  const value = String(text ?? '').trim()
  if (value.startsWith('继续')) return true
  return /^(?:continue|resume)\b/i.test(value)
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
 * for turns that started off-peak, only while peak, and only when this peak
 * window has not already been accepted.
 */
export function shouldAskPause(state, { step, nowPeak, windowKey, acceptedWindowKey, hasClaimedInput: claimedInput }) {
  if (state === null || typeof state !== 'object') return false
  if (!Number.isInteger(step) || step < 2) return false
  if (state.startedPeak === true) return false
  if (nowPeak !== true) return false
  if (typeof windowKey !== 'string' || windowKey.length === 0) return false
  if (acceptedWindowKey === windowKey) return false
  if (claimedInput === true) return false
  return true
}

/** Interpret the userQuestions answer. Only an explicit "continue" continues. */
export function answerMeansContinue(answer) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  if (answers.length === 0) return false
  const item = answers.find((entry) => entry?.id === QUESTION_ID || entry?.id === PEAK_START_QUESTION_ID) ?? answers[0]
  if (item === null || typeof item !== 'object') return false
  const selected = Array.isArray(item.selected) ? item.selected.filter((value) => typeof value === 'string') : []
  if (selected.some((value) => value.includes('暂停') || /stop|cancel/i.test(value))) return false
  if (selected.some((value) => value.includes('继续') || /continue/i.test(value))) return true
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  if (custom.length === 0) return false
  if (custom.includes('暂停') || custom.includes('不') || /stop|cancel/i.test(custom)) return false
  return custom.includes('继续') || /continue/i.test(custom)
}

/** The blocking question shown when a turn starts during peak. */
export function formatPeakStartQuestion(state, config) {
  const zone = timeZoneLabel(config?.timeZone ?? 'Asia/Shanghai')
  const label = state?.window ? `${state.window.start}–${state.window.end}` : '高峰时段'
  const remaining = Number.isFinite(state?.remainingMinutes) ? `，距空闲时段还有${formatDuration(state.remainingMinutes)}` : ''
  const quiet = config?.quietAfterContinue === false ? '' : '，也不再发送高峰提醒'
  return {
    id: PEAK_START_QUESTION_ID,
    header: '高峰时段',
    question: `现在是模型调用高峰时段（${label}，${zone}）${remaining}。是否继续本次对话？`,
    detail: `选择「暂停」会结束本轮并保留你刚发的消息；之后发送「继续」即可恢复。选择「继续」后，本高峰时段内不再询问${quiet}。`,
    options: [
      { label: '继续', description: '继续本次对话；本高峰时段内不再打扰' },
      { label: '暂停', description: '结束本轮，消息保留；稍后发送「继续」恢复' },
    ],
  }
}

/** Notice persisted when a peak-start conversation is paused. */
export function formatPeakStartPauseNotice() {
  return '⏸ 已在高峰时段暂停本次对话（消息已保留）。发送「继续」即可恢复。'
}

/** The blocking question object passed to ctx.userQuestions.ask. */
export function formatPauseQuestion(state, config) {
  const zone = timeZoneLabel(config?.timeZone ?? 'Asia/Shanghai')
  const label = state?.window ? `${state.window.start}–${state.window.end}` : '高峰时段'
  const quiet = config?.quietAfterContinue === false ? '' : '，也不再发送高峰提醒'
  return {
    id: QUESTION_ID,
    header: '已进入高峰时段',
    question: `本轮从空闲时段开始，执行过程中进入模型调用高峰时段（${label}，${zone}）。当前进度已保存，是否继续执行后续步骤？`,
    detail: `选择「暂停」会结束本轮后续步骤，进度保留；之后发送「继续」即可恢复。选择「继续」后，本高峰时段内不再询问${quiet}。`,
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

export { QUESTION_ID, PEAK_START_QUESTION_ID }
