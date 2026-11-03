import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseTimorYear, fetchYear, refreshHolidayData } from '../lib/update.js'
import { dataFilePath } from '../lib/data.js'

function tempConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peak-update-'))
  return {
    dir,
    config: {
      dataDir: dir,
      timeZone: 'Asia/Shanghai',
      updateUrls: ['https://example.test/holiday/{year}'],
      updateTimeoutMs: 1000,
      retryHours: 6,
      nextCheckHours: 24,
      retentionYears: 1,
      allowInsecureUpdate: false,
      ...overrides,
    },
  }
}

function timor(year, days) {
  const holiday = {}
  for (const day of days) holiday[day.slice(5)] = { holiday: true, date: day }
  return { code: 0, holiday }
}

function response(body, { ok = true, status = 200, contentType } = {}) {
  const headers = new Map()
  if (contentType) headers.set('content-type', contentType)
  return {
    ok,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function store() {
  return {
    schemaVersion: 1,
    updatedAt: '2026-11-03T00:00:00.000Z',
    coverageThrough: 2028,
    years: {
      2027: { status: 'partial', source: 'old', fetchedAt: '2026-01-01T00:00:00.000Z', holidays: ['2027-01-01'] },
      2028: { status: 'complete', source: 'old', fetchedAt: '2026-01-01T00:00:00.000Z', holidays: ['2028-01-01'] },
    },
    lastAttemptAt: null,
    nextCheckAt: null,
    lastError: null,
  }
}

test('parseTimorYear keeps only holiday=true dates for the requested year', () => {
  const payload = {
    code: 0,
    holiday: {
      '01-01': { holiday: true, date: '2029-01-01' },
      '01-02': { holiday: true, date: '2029-01-02' },
      '01-03': { holiday: true, date: '2029-01-03' },
      '02-04': { holiday: false, date: '2029-02-04' },
      '02-05': { holiday: true, date: '2030-02-05' },
    },
  }
  const parsed = parseTimorYear(payload, 2029)
  assert.deepEqual(parsed.holidays, ['2029-01-01', '2029-01-02', '2029-01-03'])
  assert.equal(parsed.status, 'partial')
  assert.throws(() => parseTimorYear({ code: 1 }, 2029))
  assert.throws(() => parseTimorYear({ code: 0, holiday: null }, 2029))
})

test('parseTimorYear marks a full year complete', () => {
  const days = ['2029-01-01', '2029-02-15', '2029-05-01', '2029-06-01', '2029-09-01', '2029-10-01']
  const parsed = parseTimorYear(timor(2029, days), 2029)
  assert.equal(parsed.status, 'complete')
  assert.deepEqual(parsed.holidays, days)
})

test('fetchYear replaces {year} and rejects non-https URLs', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    return response(timor(2029, ['2029-01-01']))
  }
  const result = await fetchYear('https://example.test/{year}.json', 2029, {
    config: { updateTimeoutMs: 1000 },
    fetchImpl,
  })
  assert.equal(result.url, 'https://example.test/2029.json')
  assert.deepEqual(seen, ['https://example.test/2029.json'])
  assert.deepEqual(result.parsed.holidays, ['2029-01-01'])
  await assert.rejects(() => fetchYear('http://example.test/{year}', 2029, {
    config: { updateTimeoutMs: 1000 },
    fetchImpl,
  }), /https/)
})

test('refreshHolidayData updates coverage, prunes stale years, and saves', async (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const data = store()
  const days = ['2029-01-01', '2029-02-15', '2029-05-01', '2029-06-01', '2029-09-01', '2029-10-01']
  const result = await refreshHolidayData({
    data,
    years: [2029],
    config,
    now: new Date('2029-01-04T10:00:00+08:00'),
    fetchImpl: async () => response(timor(2029, days)),
  })
  assert.equal(result.changed, true)
  assert.equal(result.data.coverageThrough, 2029)
  assert.equal(result.data.years['2029'].status, 'complete')
  assert.equal(result.data.years['2027'], undefined)
  assert.ok(result.data.years['2028'])
  assert.ok(existsSync(dataFilePath(config)))
  assert.equal(result.saveError, undefined)
})

test('empty response never overwrites data and retries later', async (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const data = store()
  const before2028 = JSON.stringify(data.years['2028'])
  const result = await refreshHolidayData({
    data,
    years: [2029],
    config,
    now: new Date('2029-01-04T10:00:00+08:00'),
    fetchImpl: async () => response({ code: 0, holiday: {} }),
  })
  assert.equal(result.changed, false)
  assert.equal(JSON.stringify(data.years['2028']), before2028)
  assert.equal(data.years['2027'], undefined)
  assert.match(data.lastError, /no holiday data published yet/)
  assert.equal(result.results[0].status, 'no-data')
  assert.equal(Date.parse(data.nextCheckAt), Date.parse('2029-01-05T02:00:00.000Z'))
})

test('HTTP failure keeps old data and schedules a retry', async (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const data = store()
  const result = await refreshHolidayData({
    data,
    years: [2029],
    config,
    now: new Date('2029-01-04T10:00:00+08:00'),
    fetchImpl: async () => response('nope', { ok: false, status: 500 }),
  })
  assert.equal(result.changed, false)
  assert.match(data.lastError, /HTTP 500/)
  assert.equal(result.results[0].status, 'error')
  assert.equal(Date.parse(data.nextCheckAt), Date.parse('2029-01-04T08:00:00.000Z'))
})

test('multiple URLs fall back to the next source', async (t) => {
  const { dir, config } = tempConfig({
    updateUrls: ['https://bad.test/{year}', 'https://good.test/{year}'],
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const data = store()
  const days = ['2029-01-01', '2029-02-15', '2029-05-01', '2029-06-01', '2029-09-01', '2029-10-01']
  const calls = []
  const result = await refreshHolidayData({
    data,
    years: [2029],
    config,
    now: new Date('2029-01-04T10:00:00+08:00'),
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.includes('bad.test')) throw new Error('boom')
      return response(timor(2029, days))
    },
  })
  assert.deepEqual(calls, ['https://bad.test/2029', 'https://good.test/2029'])
  assert.equal(result.data.years['2029'].status, 'complete')
  assert.equal(result.data.lastError, null)
})
