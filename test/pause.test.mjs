import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTurnState,
  hasClaimedInput,
  shouldAskPause,
  answerMeansContinue,
  formatPauseQuestion,
  formatPauseNotice,
  formatContinueNotice,
  formatOffPeakAfterWaitNotice,
} from '../lib/pause.js'

const state = {
  window: { start: '09:00', end: '12:00' },
  weekday: '周二',
  timeText: '09:30',
}

test('createTurnState records the start status', () => {
  assert.deepEqual(createTurnState({ turn: 3, startedPeak: false }), {
    turn: 3,
    startedPeak: false,
    acceptedWindowKey: null,
  })
})

test('hasClaimedInput ignores runtime-context only', () => {
  assert.equal(hasClaimedInput([]), false)
  assert.equal(hasClaimedInput([{ source: { kind: 'runtime-context' } }]), false)
  assert.equal(hasClaimedInput([{ source: { kind: 'user' } }]), true)
  assert.equal(hasClaimedInput([{}]), true)
})

test('shouldAskPause only after step 1 for an off-peak start', () => {
  const turn = createTurnState({ turn: 1, startedPeak: false })
  const base = { step: 2, nowPeak: true, windowKey: '2026-11-03:09:00-12:00', hasClaimedInput: false }
  assert.equal(shouldAskPause(turn, base), true)
  assert.equal(shouldAskPause(turn, { ...base, step: 1 }), false)
  assert.equal(shouldAskPause(turn, { ...base, nowPeak: false }), false)
  assert.equal(shouldAskPause(turn, { ...base, hasClaimedInput: true }), false)
  assert.equal(shouldAskPause({ ...turn, startedPeak: true }, base), false)
  assert.equal(shouldAskPause({ ...turn, acceptedWindowKey: base.windowKey }, base), false)
  assert.equal(shouldAskPause(turn, { ...base, windowKey: null }), false)
})

test('a different peak window asks again in the same turn', () => {
  const turn = { ...createTurnState({ turn: 1, startedPeak: false }), acceptedWindowKey: '2026-11-03:09:00-12:00' }
  assert.equal(shouldAskPause(turn, {
    step: 3,
    nowPeak: true,
    windowKey: '2026-11-03:14:00-18:00',
    hasClaimedInput: false,
  }), true)
})

test('answerMeansContinue is conservative', () => {
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['继续'] }] }), true)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['暂停'] }] }), false)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: [], custom: '继续吧' }] }), true)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: [], custom: '不要继续' }] }), false)
  assert.equal(answerMeansContinue({ answers: [] }), false)
  assert.equal(answerMeansContinue(null), false)
  assert.equal(answerMeansContinue({ answers: [{ id: 'peak-crossing', selected: ['stop'] }] }), false)
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
  const cont = formatContinueNotice(state, { timeZone: 'Asia/Shanghai' })
  assert.match(cont, /用户选择继续执行/)
  const off = formatOffPeakAfterWaitNotice(state, { timeZone: 'Asia/Shanghai' })
  assert.match(off, /高峰时段已结束/)
  for (const text of [pause, cont, off]) {
    assert.ok(Array.from(text).length <= 120)
  }
})
