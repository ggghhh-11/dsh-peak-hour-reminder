/**
 * Durable holiday store: load/seed, merge, prune, and coverage questions.
 *
 * File: $DSH_HOME/peak-hour-reminder/holidays.json (override with `dataDir`).
 * The file is the active source of truth; lib/holidays.js is only the seed
 * and the fallback when the file is missing or corrupt.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_DATA } from './holidays.js'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = new Set(['complete', 'partial', 'unknown'])

/** Resolve the directory that owns the runtime holiday file. */
export function resolveDataDir(config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.trim().length > 0) return config.dataDir.trim()
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(dshHome, 'peak-hour-reminder')
}

/** Absolute path of the runtime holiday file. */
export function dataFilePath(config) {
  return join(resolveDataDir(config), 'holidays.json')
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

/** Create a fresh store from the built-in baseline. */
export function seedData() {
  const data = clone(BUILTIN_DATA)
  data.lastAttemptAt = null
  data.nextCheckAt = null
  data.lastError = null
  return data
}

function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const status = STATUSES.has(entry.status) ? entry.status : 'unknown'
  const holidays = Array.isArray(entry.holidays)
    ? [...new Set(entry.holidays.filter((date) => typeof date === 'string' && DATE_KEY.test(date)))].sort()
    : []
  return {
    status,
    source: typeof entry.source === 'string' ? entry.source : 'unknown',
    fetchedAt: typeof entry.fetchedAt === 'string' ? entry.fetchedAt : null,
    holidays,
  }
}

/** Validate/normalize an on-disk store; returns null when unusable. */
export function normalizeData(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schemaVersion !== 1) return null
  if (value.years === null || typeof value.years !== 'object' || Array.isArray(value.years)) return null
  const years = {}
  for (const [key, entry] of Object.entries(value.years)) {
    if (!/^\d{4}$/.test(key)) continue
    const normalized = normalizeEntry(entry)
    if (normalized !== null) years[key] = normalized
  }
  const data = {
    schemaVersion: 1,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    coverageThrough: null,
    years,
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    nextCheckAt: typeof value.nextCheckAt === 'string' ? value.nextCheckAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
  }
  data.coverageThrough = coverageThroughOf(data)
  return data
}

/** Load the runtime store, seeding/writing it when needed. Never throws. */
export function loadData(config) {
  const file = dataFilePath(config)
  try {
    if (!existsSync(file)) {
      const data = seedData()
      trySave(config, data, 'seed')
      return data
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const data = normalizeData(parsed)
    if (data === null) throw new Error('unsupported or malformed holiday store')
    return data
  } catch (error) {
    try {
      if (existsSync(file)) copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* backup is best-effort */
    }
    console.warn(`[peak-hour-reminder] holiday store unreadable (${error instanceof Error ? error.message : String(error)}); using built-in baseline`)
    const data = seedData()
    trySave(config, data, 'seed-after-corruption')
    return data
  }
}

function trySave(config, data, reason) {
  try {
    saveData(config, data)
  } catch (error) {
    console.warn(`[peak-hour-reminder] could not write holiday store (${reason}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Atomically persist the runtime store. Throws on I/O failure. */
export function saveData(config, data) {
  const file = dataFilePath(config)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    try {
      rmSync(file, { force: true })
    } catch {
      /* target may not exist */
    }
    try {
      renameSync(tmp, file)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore cleanup failure */
      }
      throw error
    }
  }
}

/** Highest year with complete data, or null. */
export function coverageThroughOf(data) {
  let best = null
  for (const [key, entry] of Object.entries(data?.years ?? {})) {
    if (entry?.status !== 'complete') continue
    const year = Number(key)
    if (Number.isInteger(year) && (best === null || year > best)) best = year
  }
  return best
}

/** Status of one year: complete, partial, or unknown. */
export function yearStatus(data, year) {
  return data?.years?.[String(year)]?.status ?? 'unknown'
}

/** Whether one year's holiday list is incomplete. */
export function dataIncomplete(data, year) {
  return yearStatus(data, year) !== 'complete'
}

/**
 * Remove stale years and recompute coverage.
 * Policy: keep `retentionYears` past years, current/future complete data, and
 * at most three future years; drop incomplete past years.
 * @returns {number[]} removed years
 */
export function pruneData(data, currentYear, retentionYears = 1) {
  const keepPast = Number.isInteger(retentionYears) ? Math.max(0, Math.min(5, retentionYears)) : 1
  const cutoff = currentYear - keepPast
  const removed = []
  for (const [key, entry] of Object.entries(data.years ?? {})) {
    const year = Number(key)
    if (!Number.isInteger(year)) {
      delete data.years[key]
      continue
    }
    if (year < cutoff || year > currentYear + 3 || (entry?.status !== 'complete' && year < currentYear)) {
      delete data.years[key]
      removed.push(year)
    }
  }
  data.coverageThrough = coverageThroughOf(data)
  if (removed.length > 0) data.updatedAt = new Date().toISOString()
  return removed.sort((a, b) => a - b)
}

/** Whether the current year (or the Q4 next year) needs a refresh. */
export function needsUpdate(data, parts) {
  if (data === null || typeof data !== 'object') return true
  const currentYear = parts?.year
  if (!Number.isInteger(currentYear)) return true
  if (data.coverageThrough === null || data.coverageThrough === undefined) return true
  if (currentYear > data.coverageThrough) return true
  if (yearStatus(data, currentYear) !== 'complete') return true
  if (parts.month >= 10 && yearStatus(data, currentYear + 1) !== 'complete') return true
  return false
}

/** Years worth fetching for the current turn. */
export function targetYears(data, parts) {
  const currentYear = parts?.year
  if (!Number.isInteger(currentYear)) return []
  const years = new Set()
  if (data?.coverageThrough === null || data?.coverageThrough === undefined || currentYear > data.coverageThrough || yearStatus(data, currentYear) !== 'complete') {
    years.add(currentYear)
  }
  if (parts.month >= 10 && yearStatus(data, currentYear + 1) !== 'complete') {
    years.add(currentYear + 1)
  }
  return [...years].sort((a, b) => a - b)
}

function statusRank(status) {
  if (status === 'complete') return 2
  if (status === 'partial') return 1
  return 0
}

function timeOf(value) {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Merge one fetched year with precedence complete > partial > unknown, then
 * more holidays, then newer fetchedAt. Returns whether the store changed.
 */
export function mergeYear(data, year, entry) {
  const key = String(year)
  const normalized = normalizeEntry(entry)
  if (normalized === null) return false
  const old = data.years[key]
  if (old === undefined) {
    data.years[key] = normalized
    data.coverageThrough = coverageThroughOf(data)
    return true
  }
  const oldRank = statusRank(old.status)
  const newRank = statusRank(normalized.status)
  let replace = false
  if (newRank > oldRank) replace = true
  else if (newRank < oldRank) replace = false
  else if (normalized.holidays.length > old.holidays.length) replace = true
  else if (normalized.holidays.length < old.holidays.length) replace = false
  else replace = timeOf(normalized.fetchedAt) > timeOf(old.fetchedAt)
  if (!replace) return false
  data.years[key] = normalized
  data.coverageThrough = coverageThroughOf(data)
  return true
}

/** Whether the persisted nextCheckAt has elapsed (missing/invalid means due). */
export function refreshDueAt(data, nowMs) {
  if (typeof data?.nextCheckAt !== 'string' || data.nextCheckAt.length === 0) return true
  const parsed = Date.parse(data.nextCheckAt)
  if (Number.isNaN(parsed)) return true
  return nowMs >= parsed
}

/** ISO timestamp `hours` from now. */
export function nextCheckIso(nowMs, hours) {
  return new Date(nowMs + hours * 60 * 60 * 1000).toISOString()
}
