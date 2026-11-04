import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTurnState,
  hasClaimedInput,
  hasHumanMessage,
  firstHumanText,
  isResumeIntent,
  shouldAskPause,
  answerMeansContinue,
  formatPauseQuestion,
  formatPauseNotice,
  formatPeakStartQuestion,
  formatPeakStartPauseNotice,
  formatContinueNotice,
  formatOffPeakAfterWaitNotice,
} from '../lib/pause.js'

const state = {
  window: { start: '09:00', end: '12:00' },
  weekday: '周二',
  timeText: '09:30',
  remainingMinutes: 150,
}

test('createTurnState records the start status', () => {
  assert.deepEqual(createTurnState({ turn: 3, startedPeak: false }), {
    turn: 3,
    startedPeak: false,
  })
})

test('hasClaimedInput ignores runtime-context only', () => {
  assert.equal(hasClaimedInput([]), false)
  assert.equal(hasClaimedInput([{ source: { kind: 'runtime-context' } }]), false)
  assert.equal(hasClaimedInput([{ source: { kind: 'user' } }]), true)
  assert.equal(hasClaimedInput([{}]), true)
})

test('hasHumanMessage only accepts role=user source=user', () => {
  assert.equal(hasHumanMessage([]), false)
  assert.equal(hasHumanMessage([{ role: 'user', source: { kind: 'runtime-context' } }]), false)
  assert.equal(hasHumanMessage([{ role: 'user', content: [], source: { kind: 'user' } }]), true)
  assert.equal(hasHumanMessage([{ role: 'assistant', source: { kind: 'user' } }]), false)
})

test('firstHumanText extracts the first human text', () => {
  assert.equal(firstHumanText([]), '')
  assert.equal(firstHumanText([
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }, { type: 'image' }] },
  ]), '继续')
})

test('isResumeIntent only accepts explicit resume wording', () => {
  assert.equal(isResumeIntent('继续'), true)
  assert.equal(isResumeIntent('继续吧'), true)
  assert.equal(isResumeIntent('continue'), true)
  assert.equal(isResumeIntent('Resume please'), true)
  assert.equal(isResumeIntent('现在几点了'), false)
  assert.equal(isResumeIntent(''), false)
})

test('shouldAskPause only after step 1 for an off-peak start', () => {
  const turn = createTurnState({ turn: 1, startedPeak: false })
  const base = { step: 2, nowPeak: true, windowKey: '2026-11-03:09:00-12:00', acceptedWindowKey: null, hasClaimedInput: false }
  assert.equal(shouldAskPause(turn, base), true)
  assert.equal(shouldAskPause(turn, { ...base, step: 1 }), false)
  assert.equal(shouldAskPause(turn, { ...base, nowPeak: false }), false)
  assert.equal(shouldAskPause(turn, { ...base, hasClaimedInput: true }), false)
  assert.equal(shouldAskPause({ ...turn, startedPeak: true }, base), false)
  assert.equal(shouldAskPause(turn, { ...base, acceptedWindowKey: base.windowKey }), false)
  assert.equal(shouldAskPause(turn, { ...base, windowKey: null }), false)
})

test('a different peak window asks again even if another window was accepted', () => {
  const turn = createTurnState({ turn: 1, startedPeak: false })
  assert.equal(shouldAskPause(turn, {
    step: 3,
    nowPeak: true,
    windowKey: '2026-11-03:14:00-18:00',
    acceptedWindowKey: '2026-11-03:09:00-12:00',
    hasClaimedInput: false,
  }), true)
})

test('answerMeansContinue is conservative', () => {
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['继续'] }] }), true)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-start', selected: ['继续'] }] }), true)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['暂停'] }] }), false)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: [], custom: '继续吧' }] }), true)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: [], custom: '不要继续' }] }), false)
  assert.equal(answerMeansContinue({ answers: [] }), false)
  assert.equal(answerMeansContinue(null), false)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['stop'] }] }), false)
})

test('peak-start question names time, window, and both options', () => {
  const question = formatPeakStartQuestion(state, { timeZone: 'Asia/Shanghai' })
  assert.equal(question.id, 'peak-start')
  assert.match(question.question, /09:00–12:00/)
  assert.match(question.question, /北京时间/)
  assert.match(question.question, /2 小时 30 分钟/)
  assert.match(question.detail, /消息已保留|保留你刚发的消息/)
  assert.deepEqual(question.options.map((option) => option.label), ['继续', '暂停'])
})

test('pause question names the window, saved progress, and both options', () => {
  const question = formatPauseQuestion(state, { timeZone: 'Asia/Shanghai' })
  assert.equal(question.id, 'peak-crossing')
  assert.match(question.question, /09:00–12:00/)
  assert.match(question.question, /北京时间/)
  assert.match(question.detail, /进度保留/)
  assert.deepEqual(question.options.map((option) => option.label), ['继续', '暂停'])
})

test('pause/continue/off-peak notices are distinct and bounded', () => {
  const pause = formatPauseNotice()
  assert.match(pause, /暂停后续步骤/)
  assert.match(pause, /进度已保存/)
  const startPause = formatPeakStartPauseNotice()
  assert.match(startPause, /本次对话/)
  assert.match(startPause, /消息已保留/)
  const cont = formatContinueNotice(state, { timeZone: 'Asia/Shanghai' })
  assert.match(cont, /用户选择继续执行/)
  const off = formatOffPeakAfterWaitNotice(state, { timeZone: 'Asia/Shanghai' })
  assert.match(off, /高峰时段已结束/)
  for (const text of [pause, startPause, cont, off]) {
    assert.ok(Array.from(text).length <= 120)
  }
})
