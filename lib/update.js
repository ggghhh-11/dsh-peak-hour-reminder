/**
 * Holiday data refresh: fetch one year from a configured endpoint, validate
 * the timor.tech schema, merge into the store, prune stale years, and persist.
 *
 * Only `holiday: true` dates are taken from the timor response; `holiday:
 * false` entries are makeup workdays and do not change DeepSeek's peak rule
 * (weekends stay off-peak regardless of a makeup workday).
 */

import { getDateParts } from './peak.js'
import { seedData, pruneData, mergeYear, saveData, targetYears, nextCheckIso } from './data.js'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const MAX_BODY_BYTES = 1024 * 1024
const USER_AGENT = 'dsh-peak-hour-reminder/0.1.0'

/** Parse one timor.tech year response. Throws on structural failure. */
export function parseTimorYear(payload, year) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('holiday payload must be an object')
  }
  if (payload.code !== 0) throw new Error(`holiday endpoint returned code ${JSON.stringify(payload.code)}`)
  if (payload.holiday === null || typeof payload.holiday !== 'object' || Array.isArray(payload.holiday)) {
    throw new Error('holiday payload is missing the holiday object')
  }
  const dates = new Set()
  for (const item of Object.values(payload.holiday)) {
    if (item === null || typeof item !== 'object') continue
    if (item.holiday !== true) continue
    const date = typeof item.date === 'string' ? item.date : ''
    if (!DATE_KEY.test(date)) continue
    if (Number(date.slice(0, 4)) !== year) continue
    dates.add(date)
  }
  const holidays = [...dates].sort()
  if (holidays.length === 0) return { status: 'unknown', holidays }
  return { status: holidays.length >= 5 ? 'complete' : 'partial', holidays }
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined || signal === null) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  const controller = new AbortController()
  const abort = (reason) => controller.abort(reason)
  if (signal.aborted) abort(signal.reason)
  else signal.addEventListener('abort', () => abort(signal.reason), { once: true })
  timeout.addEventListener('abort', () => abort(timeout.reason), { once: true })
  return controller.signal
}

function headerValue(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null
  } catch {
    return null
  }
}

/**
 * Fetch and parse one year from one URL template.
 * @returns {Promise<{url: string, parsed: {status: string, holidays: string[]}}>}
 */
export async function fetchYear(template, year, options = {}) {
  const config = options.config ?? {}
  const url = String(template).replaceAll('{year}', String(year))
  if (!/^https:\/\//i.test(url) && config.allowInsecureUpdate !== true) {
    throw new Error(`holiday update URL must use https: ${url}`)
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('this runtime has no fetch implementation')
  const timeoutMs = Number.isSafeInteger(config.updateTimeoutMs) ? config.updateTimeoutMs : 4000
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    signal: combineSignals(options.signal, timeoutMs),
  })
  if (response?.ok === false) throw new Error(`HTTP ${response.status ?? 'error'} from ${url}`)
  const declared = Number(headerValue(response, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error(`response too large (${declared} bytes)`)
  const text = await response.text()
  if (typeof text !== 'string') throw new Error('holiday response was not text')
  if (text.length > MAX_BODY_BYTES) throw new Error(`response too large (${text.length} chars)`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error(`holiday response is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { url, parsed: parseTimorYear(payload, year) }
}

/**
 * Refresh the requested years, merge successful data, prune stale years, and
 * persist. Never throws; failures are returned in `results`.
 * @param {object} options
 * @param {object} options.data - current store
 * @param {number[]} [options.years] - years to fetch; defaults from targetYears
 * @param {object} options.config - normalized config
 * @param {Function} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {Date} [options.now]
 * @returns {Promise<{data: object, changed: boolean, results: object[], saveError?: string}>}
 */
export async function refreshHolidayData(options) {
  const config = options.config ?? {}
  const fetchImpl = options.fetchImpl
  const signal = options.signal
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const nowMs = now.getTime()
  const data = options.data ?? seedData()
  const parts = getDateParts(now, config.timeZone ?? 'Asia/Shanghai')
  const years = Array.isArray(options.years) && options.years.length > 0
    ? [...new Set(options.years)].sort((a, b) => a - b)
    : targetYears(data, parts)
  const urls = Array.isArray(config.updateUrls) && config.updateUrls.length > 0
    ? config.updateUrls
    : ['https://timor.tech/api/holiday/year/{year}']

  const results = []
  const errors = []
  const completedYears = new Set()
  let changed = false
  let sawNoData = false

  for (const year of years) {
    if (signal?.aborted === true) break
    let done = false
    for (const template of urls) {
      if (signal?.aborted === true) break
      try {
        const { url, parsed } = await fetchYear(template, year, { config, fetchImpl, signal })
        if (parsed.status === 'unknown') {
          sawNoData = true
          results.push({ year, url, status: 'no-data' })
          continue
        }
        const entry = {
          status: parsed.status,
          source: url,
          fetchedAt: now.toISOString(),
          holidays: parsed.holidays,
        }
        if (mergeYear(data, year, entry)) changed = true
        results.push({ year, url, status: parsed.status })
        completedYears.add(year)
        done = true
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push({ year, url: template, message })
        results.push({ year, url: template, status: 'error', error: message })
        if (signal?.aborted === true) break
      }
    }
    if (!done && signal?.aborted === true) break
  }

  data.lastAttemptAt = now.toISOString()
  if (completedYears.size < years.length && errors.length > 0) data.lastError = errors[0].message
  else if (sawNoData) data.lastError = `no holiday data published yet for ${years.join(', ')}`
  else data.lastError = null

  pruneData(data, parts.year, config.retentionYears ?? 1)
  const failed = errors.length > 0 && completedYears.size < years.length
  const retry = failed || signal?.aborted === true
  const hours = retry ? (config.retryHours ?? 6) : (config.nextCheckHours ?? 24)
  data.nextCheckAt = nextCheckIso(nowMs, hours)
  if (changed) data.updatedAt = now.toISOString()

  let saveError
  try {
    saveData(config, data)
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error)
  }
  return { data, changed, results, ...(saveError === undefined ? {} : { saveError }) }
}
