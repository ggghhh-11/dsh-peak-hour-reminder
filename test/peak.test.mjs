import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig,
  resolvePeakState,
  formatReminder,
  formatDuration,
  truncateSummary,
  getDateParts,
} from '../lib/peak.js'

const baseConfig = normalizeConfig({}).config
const data = {
  schemaVersion: 1,
  coverageThrough: 2026,
  years: {
    2026: { status: 'complete', holidays: ['2026-10-01', '2026-10-02'] },
    2027: { status: 'partial', holidays: ['2027-01-01'] },
  },
}

function at(iso, config = baseConfig, holidays = data) {
  return resolvePeakState(new Date(iso), config, holidays)
}

test('weekday peak boundaries in Beijing time', () => {
  assert.equal(at('2026-11-03T08:59:00+08:00').peak, false)
  const nine = at('2026-11-03T09:00:00+08:00')
  assert.equal(nine.peak, true)
  assert.deepEqual({ start: nine.window.start, end: nine.window.end }, { start: '09:00', end: '12:00' })
  assert.equal(at('2026-11-03T11:59:00+08:00').peak, true)
  assert.equal(at('2026-11-03T12:00:00+08:00').peak, false)
  assert.equal(at('2026-11-03T13:59:00+08:00').peak, false)
  const fourteen = at('2026-11-03T14:00:00+08:00')
  assert.equal(fourteen.peak, true)
  assert.equal(fourteen.window.start, '14:00')
  assert.equal(at('2026-11-03T17:59:00+08:00').peak, true)
  assert.equal(at('2026-11-03T18:00:00+08:00').peak, false)
})

test('remaining minutes are measured to the current window end', () => {
  const state = at('2026-11-03T10:23:00+08:00')
  assert.equal(state.peak, true)
  assert.equal(state.remainingMinutes, 97)
  assert.equal(formatDuration(state.remainingMinutes), '1 小时 37 分钟')
  assert.equal(formatDuration(60), '1 小时')
  assert.equal(formatDuration(1), '1 分钟')
})

test('weekends are off-peak by default', () => {
  assert.equal(at('2026-11-07T10:00:00+08:00').reason, 'weekend')
  assert.equal(at('2026-11-08T15:00:00+08:00').reason, 'weekend')
  const weekendPeak = normalizeConfig({ weekendOffPeak: false }).config
  assert.equal(at('2026-11-07T10:00:00+08:00', weekendPeak).peak, true)
})

test('Chinese public holidays are off-peak', () => {
  const state = at('2026-10-01T10:00:00+08:00')
  assert.equal(state.peak, false)
  assert.equal(state.reason, 'holiday')
})

test('extraHolidays covers user-defined days off', () => {
  const config = normalizeConfig({ extraHolidays: ['2026-11-03'] }).config
  assert.equal(at('2026-11-03T10:00:00+08:00', config).reason, 'holiday')
})

test('time zone changes the wall-clock reading', () => {
  const sameInstant = '2026-11-03T02:00:00Z'
  const shanghai = normalizeConfig({ timeZone: 'Asia/Shanghai' }).config
  const utc = normalizeConfig({ timeZone: 'UTC' }).config
  assert.equal(at(sameInstant, shanghai).peak, true)
  assert.equal(at(sameInstant, utc).peak, false)
  assert.equal(at(sameInstant, shanghai).timeText, '10:00')
  assert.equal(at(sameInstant, utc).timeText, '02:00')
})

test('overnight peak windows work', () => {
  const config = normalizeConfig({ peakWindows: [{ start: '22:00', end: '02:00' }] }).config
  const late = at('2026-11-03T23:00:00+08:00', config)
  assert.equal(late.peak, true)
  assert.equal(late.remainingMinutes, 180)
  const early = at('2026-11-04T01:00:00+08:00', config)
  assert.equal(early.peak, true)
  assert.equal(early.remainingMinutes, 60)
  assert.equal(at('2026-11-04T02:00:00+08:00', config).peak, false)
})

test('invalid config values fall back with warnings', () => {
  const { config, warnings } = normalizeConfig({
    timeZone: 'Not/AZone',
    peakWindows: [{ start: '25:00', end: '26:00' }, { start: '09:00', end: '09:00' }],
    extraHolidays: ['not-a-date'],
    updateUrls: ['https://example.com/no-year'],
  })
  assert.equal(config.timeZone, 'Asia/Shanghai')
  assert.equal(config.peakWindows[0].start, '09:00')
  assert.equal(config.extraHolidays.length, 0)
  assert.equal(config.updateUrls[0], 'https://timor.tech/api/holiday/year/{year}')
  assert.ok(warnings.length >= 4)
})

test('reminder text includes time, window, remaining, and is bounded', () => {
  const state = at('2026-11-03T10:23:00+08:00')
  const reminder = formatReminder(state, baseConfig)
  assert.match(reminder.text, /周二 10:23/)
  assert.match(reminder.text, /09:00–12:00/)
  assert.match(reminder.text, /1 小时 37 分钟/)
  assert.match(reminder.text, /2 倍/)
  assert.ok(Array.from(reminder.summary).length <= 120)
  assert.ok(reminder.summary.includes('高峰时段提醒'))
})

test('price hint and incomplete-data suffix are controllable', () => {
  const state = at('2026-11-03T10:23:00+08:00')
  const noPrice = formatReminder(state, { ...baseConfig, showPriceHint: false })
  assert.equal(noPrice.text.includes('2 倍'), false)
  const incomplete = formatReminder(state, baseConfig, { incompleteYear: 2026 })
  assert.match(incomplete.text, /2026 年节假日数据尚未更新/)
})

test('truncateSummary never splits an emoji', () => {
  const text = `⏰ ${'高'.repeat(119)}😀尾`
  const out = truncateSummary(text, 120)
  assert.ok(Array.from(out).length <= 120)
  assert.equal(out.endsWith('…'), true)
})

test('getDateParts accepts Date and ISO strings', () => {
  const fromDate = getDateParts(new Date('2026-11-03T10:23:00+08:00'), 'Asia/Shanghai')
  const fromString = getDateParts('2026-11-03T10:23:00+08:00', 'Asia/Shanghai')
  assert.equal(fromDate.dateKey, '2026-11-03')
  assert.equal(fromDate.weekdayIndex, 2)
  assert.equal(fromString.timeText, '10:23')
})
