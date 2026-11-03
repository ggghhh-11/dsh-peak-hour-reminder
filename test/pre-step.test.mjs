import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const DATA = {
  schemaVersion: 1,
  coverageThrough: 2026,
  years: {
    2026: { status: 'complete', source: 'test', fetchedAt: '2026-01-01T00:00:00Z', holidays: [] },
    2027: { status: 'partial', source: 'test', fetchedAt: '2026-01-01T00:00:00Z', holidays: ['2027-01-01'] },
  },
}

function makeDecision(extra = []) {
  return {
    kind: 'enter',
    messages: [
      { id: 'runtime', role: 'user', content: [], source: { kind: 'runtime-context' } },
      ...extra,
    ],
  }
}

function setup(options = {}) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    effect() {
      return () => {}
    },
  }
  const clock = { value: new Date(options.now ?? '2026-11-03T08:59:00+08:00') }
  const appended = []
  const agent = {
    session: {
      header: { origin: options.origin ?? 'main' },
      append(type, message, opts) {
        appended.push({ type, message, opts })
      },
    },
  }
  const asks = []
  const userQuestions = {
    async ask(request) {
      asks.push(request)
      if (options.askError) throw options.askError
      if (typeof options.answer === 'function') return options.answer(request)
      return options.answer ?? { answers: [{ id: 'peak-crossing', selected: ['继续'] }] }
    },
  }
  apply(ctx, {
    updateEnabled: false,
    ...options.config,
  }, {
    data: options.data ?? DATA,
    userQuestions,
    now: () => clock.value,
    disableTimers: true,
    fetchImpl: options.fetchImpl,
  })
  const handler = handlers.get('agent/pre-step')
  return {
    handler,
    ctx,
    agent,
    clock,
    asks,
    appended,
    decision: makeDecision,
    payload(step, turn = 1) {
      return { agent, turn, step, signal: new AbortController().signal }
    },
    async run(step, decision = makeDecision(), turn = 1) {
      return handler({ agent, turn, step, signal: new AbortController().signal }, async () => decision)
    },
  }
}

test('a turn starting during peak gets exactly one peak notice', async () => {
  const s = setup({ now: '2026-11-03T10:00:00+08:00' })
  const result = await s.run(1)
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, 2)
  const notice = result.messages.at(-1)
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'plugin:dsh-peak-hour-reminder')
  assert.equal(notice.source.form, 'notice')
  assert.match(notice.source.summary, /高峰时段提醒/)
  assert.match(notice.content[0].text, /09:00–12:00/)
  assert.equal(s.appended.length, 0)
})

test('an off-peak turn start does nothing', async () => {
  const s = setup({ now: '2026-11-03T19:40:00+08:00' })
  const result = await s.run(1)
  assert.equal(result.messages.length, 1)
  assert.equal(s.appended.length, 0)
})

test('crossing into peak asks, and continue proceeds with a notice', async () => {
  const s = setup({ now: '2026-11-03T08:59:00+08:00' })
  assert.equal((await s.run(1)).messages.length, 1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  const result = await s.run(2)
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, 2)
  assert.match(result.messages.at(-1).content[0].text, /用户选择继续执行/)
  assert.equal(s.asks.length, 1)
  assert.equal(s.asks[0].questions[0].id, 'peak-crossing')
  assert.deepEqual(s.asks[0].questions[0].options.map((option) => option.label), ['继续', '暂停'])
  assert.equal(s.appended.length, 0)
  // same window: no second ask
  s.clock.value = new Date('2026-11-03T09:05:00+08:00')
  await s.run(3)
  assert.equal(s.asks.length, 1)
})

test('crossing into a new peak window asks again', async () => {
  const s = setup({ now: '2026-11-03T08:59:00+08:00' })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  await s.run(2)
  s.clock.value = new Date('2026-11-03T09:05:00+08:00')
  await s.run(3)
  s.clock.value = new Date('2026-11-03T14:01:00+08:00')
  await s.run(4)
  assert.equal(s.asks.length, 2)
})

test('pause appends a durable notice and rejects the next step', async () => {
  const s = setup({
    now: '2026-11-03T08:59:00+08:00',
    answer: { answers: [{ id: 'peak-crossing', selected: ['暂停'] }] },
  })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  const result = await s.run(2)
  assert.deepEqual(result, { kind: 'reject' })
  assert.equal(s.appended.length, 1)
  assert.equal(s.appended[0].type, 'user/message')
  assert.equal(s.appended[0].message.source.form, 'notice')
  assert.match(s.appended[0].message.content[0].text, /暂停后续步骤/)
})

test('no answerer falls back to pause + notice', async () => {
  const error = Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' })
  const s = setup({ now: '2026-11-03T08:59:00+08:00', askError: error })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  const result = await s.run(2)
  assert.deepEqual(result, { kind: 'reject' })
  assert.equal(s.appended.length, 1)
})

test('ASK_ABORTED rejects without appending a pause notice', async () => {
  const error = Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })
  const s = setup({ now: '2026-11-03T08:59:00+08:00', askError: error })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  const result = await s.run(2)
  assert.deepEqual(result, { kind: 'reject' })
  assert.equal(s.appended.length, 0)
})

test('claimed input is processed before asking', async () => {
  const s = setup({ now: '2026-11-03T08:59:00+08:00' })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  const decision = makeDecision([{ id: 'u2', role: 'user', content: [], source: { kind: 'user' } }])
  const result = await s.run(2, decision)
  assert.equal(result.messages.length, 2)
  assert.equal(s.asks.length, 0)
})

test('a turn that started during peak is not asked again', async () => {
  const s = setup({ now: '2026-11-03T10:00:00+08:00' })
  const first = await s.run(1)
  assert.equal(first.messages.length, 2)
  s.clock.value = new Date('2026-11-03T10:05:00+08:00')
  await s.run(2)
  assert.equal(s.asks.length, 0)
})

test('pauseOnPeakCrossing=false disables the question', async () => {
  const s = setup({
    now: '2026-11-03T08:59:00+08:00',
    config: { pauseOnPeakCrossing: false },
  })
  await s.run(1)
  s.clock.value = new Date('2026-11-03T09:01:00+08:00')
  await s.run(2)
  assert.equal(s.asks.length, 0)
})

test('subagent turns are completely ignored', async () => {
  const s = setup({ now: '2026-11-03T10:00:00+08:00', origin: 'subagent' })
  const result = await s.run(1)
  assert.equal(result.messages.length, 1)
  s.clock.value = new Date('2026-11-03T10:05:00+08:00')
  await s.run(2)
  assert.equal(s.asks.length, 0)
})

test('a plugin loaded mid-turn does not surprise-pause', async () => {
  const s = setup({ now: '2026-11-03T10:00:00+08:00' })
  const result = await s.run(2)
  assert.equal(result.messages.length, 1)
  assert.equal(s.asks.length, 0)
})

test('enabled=false registers no listener', () => {
  const handlers = new Map()
  const ctx = { on: (event, handler) => { handlers.set(event, handler) }, effect: () => () => {} }
  apply(ctx, { enabled: false }, { data: DATA, disableTimers: true })
  assert.equal(handlers.has('agent/pre-step'), false)
})
