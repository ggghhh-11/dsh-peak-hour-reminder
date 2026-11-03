import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  dataFilePath,
  loadData,
  saveData,
  seedData,
  normalizeData,
  pruneData,
  needsUpdate,
  targetYears,
  mergeYear,
  dataIncomplete,
  yearStatus,
  refreshDueAt,
} from '../lib/data.js'

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'peak-data-'))
  return { dir, config: { dataDir: dir } }
}

test('missing store is seeded and reloadable', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = loadData(config)
  assert.equal(yearStatus(first, 2026), 'complete')
  assert.equal(yearStatus(first, 2027), 'partial')
  assert.equal(first.coverageThrough, 2026)
  const second = loadData(config)
  assert.deepEqual(second.years[2026].holidays, first.years[2026].holidays)
  assert.ok(dataFilePath(config).startsWith(dir))
})

test('saveData round-trips a modified store', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const data = seedData()
  data.years[2028] = { status: 'complete', source: 'test', fetchedAt: '2026-11-03T00:00:00Z', holidays: ['2028-01-01'] }
  data.coverageThrough = 2028
  saveData(config, data)
  const loaded = loadData(config)
  assert.equal(loaded.coverageThrough, 2028)
  assert.deepEqual(loaded.years[2028].holidays, ['2028-01-01'])
})

test('corrupt store is backed up and replaced by the built-in baseline', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(dataFilePath(config), '{not json', 'utf8')
  const data = loadData(config)
  assert.equal(yearStatus(data, 2026), 'complete')
  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
})

test('normalizeData rejects unusable shapes', () => {
  assert.equal(normalizeData(null), null)
  assert.equal(normalizeData({ schemaVersion: 99, years: {} }), null)
  assert.equal(normalizeData({ schemaVersion: 1, years: [] }), null)
})

test('pruneData keeps recent years and drops stale ones', () => {
  const data = {
    schemaVersion: 1,
    years: {
      2025: { status: 'complete', holidays: [] },
      2026: { status: 'complete', holidays: [] },
      2027: { status: 'partial', holidays: [] },
      2028: { status: 'complete', holidays: [] },
      2031: { status: 'complete', holidays: [] },
      2035: { status: 'complete', holidays: [] },
    },
    coverageThrough: null,
  }
  const removed = pruneData(data, 2029, 1)
  assert.deepEqual(removed, [2025, 2026, 2027, 2035])
  assert.deepEqual(Object.keys(data.years).sort(), ['2028', '2031'])
  assert.equal(data.coverageThrough, 2031)
})

test('needsUpdate covers current-year, future-year, and Q4 prefetch', () => {
  const data = {
    coverageThrough: 2026,
    years: {
      2026: { status: 'complete', holidays: [] },
      2027: { status: 'partial', holidays: [] },
    },
  }
  assert.equal(needsUpdate(data, { year: 2026, month: 5 }), false)
  assert.equal(needsUpdate(data, { year: 2026, month: 11 }), true)
  assert.equal(needsUpdate(data, { year: 2027, month: 1 }), true)
  assert.equal(needsUpdate({ coverageThrough: 2028, years: { 2028: { status: 'complete' } } }, { year: 2029, month: 1 }), true)
  assert.equal(needsUpdate({ coverageThrough: null, years: {} }, { year: 2026, month: 1 }), true)
})

test('targetYears picks the current and/or next year', () => {
  const data = {
    coverageThrough: 2026,
    years: { 2026: { status: 'complete' }, 2027: { status: 'partial' } },
  }
  assert.deepEqual(targetYears(data, { year: 2026, month: 11 }), [2027])
  assert.deepEqual(targetYears(data, { year: 2027, month: 1 }), [2027])
  assert.deepEqual(targetYears({ coverageThrough: 2028, years: { 2028: { status: 'complete' } } }, { year: 2029, month: 1 }), [2029])
  assert.deepEqual(targetYears({ coverageThrough: 2028, years: { 2028: { status: 'complete' } } }, { year: 2028, month: 5 }), [])
})

test('mergeYear never lets weaker data replace stronger data', () => {
  const data = {
    coverageThrough: 2026,
    years: {
      2026: { status: 'complete', source: 'a', fetchedAt: '2026-01-01T00:00:00Z', holidays: ['2026-01-01', '2026-01-02', '2026-01-03'] },
    },
  }
  assert.equal(mergeYear(data, 2026, { status: 'partial', holidays: ['2026-01-01'] }), false)
  assert.equal(mergeYear(data, 2026, { status: 'complete', holidays: ['2026-01-01'] }), false)
  assert.equal(mergeYear(data, 2026, { status: 'complete', fetchedAt: '2026-02-01T00:00:00Z', holidays: ['2026-01-01', '2026-01-02', '2026-01-03'] }), true)
  assert.equal(mergeYear(data, 2027, { status: 'complete', fetchedAt: '2026-02-01T00:00:00Z', holidays: ['2027-01-01'] }), true)
  assert.equal(data.coverageThrough, 2027)
})

test('dataIncomplete and refreshDueAt', () => {
  const data = { coverageThrough: 2026, years: { 2026: { status: 'complete' }, 2027: { status: 'partial' } } }
  assert.equal(dataIncomplete(data, 2026), false)
  assert.equal(dataIncomplete(data, 2027), true)
  assert.equal(refreshDueAt({}, 1000), true)
  assert.equal(refreshDueAt({ nextCheckAt: 'invalid' }, 1000), true)
  assert.equal(refreshDueAt({ nextCheckAt: new Date(2000).toISOString() }, 1000), false)
  assert.equal(refreshDueAt({ nextCheckAt: new Date(1000).toISOString() }, 2000), true)
})
