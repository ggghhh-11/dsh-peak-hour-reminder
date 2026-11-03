/**
 * Pure peak-hour policy: time-zone reading, peak windows, holidays, and the
 * user-facing reminder text.
 *
 * The official DeepSeek API rule (checked 2026-11-03) is:
 *   peak = 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 *          excluding Chinese public holidays
 * which is 09:00-12:00 and 14:00-18:00 Beijing time on weekdays.
 * Weekends and Chinese public holidays are off-peak all day.
 */

export const DEFAULT_WINDOWS = Object.freeze([
  { start: '09:00', end: '12:00', startMinutes: 9 * 60, endMinutes: 12 * 60, label: '09:00–12:00' },
  { start: '14:00', end: '18:00', startMinutes: 14 * 60, endMinutes: 18 * 60, label: '14:00–18:00' },
])

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  timeZone: 'Asia/Shanghai',
  peakWindows: DEFAULT_WINDOWS,
  weekendOffPeak: true,
  showPriceHint: true,
  pauseOnPeakCrossing: true,
  dataDir: null,
  updateEnabled: true,
  updateUrls: ['https://timor.tech/api/holiday/year/{year}'],
  allowInsecureUpdate: false,
  updateTimeoutMs: 4000,
  blockingUpdateMs: 2000,
  updateCheckIntervalMinutes: 30,
  nextCheckHours: 24,
  retryHours: 6,
  retentionYears: 1,
  extraHolidays: [],
  debugNow: null,
  debugForceUpdate: false,
  debugForcePause: false,
})

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const formatterCache = new Map()

/**
 * Validate and normalize raw plugin config. Invalid values fall back to the
 * defaults with a warning instead of failing plugin load.
 * @param {unknown} raw
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const enabled = booleanOf(input.enabled, DEFAULT_CONFIG.enabled)
  const weekendOffPeak = booleanOf(input.weekendOffPeak, DEFAULT_CONFIG.weekendOffPeak)
  const showPriceHint = booleanOf(input.showPriceHint, DEFAULT_CONFIG.showPriceHint)
  const pauseOnPeakCrossing = booleanOf(input.pauseOnPeakCrossing, DEFAULT_CONFIG.pauseOnPeakCrossing)
  const updateEnabled = booleanOf(input.updateEnabled, DEFAULT_CONFIG.updateEnabled)
  const allowInsecureUpdate = booleanOf(input.allowInsecureUpdate, DEFAULT_CONFIG.allowInsecureUpdate)
  const debugForceUpdate = booleanOf(input.debugForceUpdate, DEFAULT_CONFIG.debugForceUpdate)
  const debugForcePause = booleanOf(input.debugForcePause, DEFAULT_CONFIG.debugForcePause)

  const timeZone = validateTimeZone(input.timeZone, warnings)
  const peakWindows = normalizeWindows(input.peakWindows, warnings)
  const extraHolidays = normalizeHolidayList(input.extraHolidays, warnings)
  const updateUrls = normalizeUrls(input.updateUrls, warnings)
  const dataDir = typeof input.dataDir === 'string' && input.dataDir.trim().length > 0
    ? input.dataDir.trim()
    : null

  const updateTimeoutMs = integerInRange(input.updateTimeoutMs, 500, 60_000, DEFAULT_CONFIG.updateTimeoutMs, 'updateTimeoutMs', warnings)
  const blockingUpdateMs = integerInRange(input.blockingUpdateMs, 0, 10_000, DEFAULT_CONFIG.blockingUpdateMs, 'blockingUpdateMs', warnings)
  const updateCheckIntervalMinutes = integerInRange(input.updateCheckIntervalMinutes, 1, 24 * 60, DEFAULT_CONFIG.updateCheckIntervalMinutes, 'updateCheckIntervalMinutes', warnings)
  const nextCheckHours = integerInRange(input.nextCheckHours, 1, 24 * 14, DEFAULT_CONFIG.nextCheckHours, 'nextCheckHours', warnings)
  const retryHours = integerInRange(input.retryHours, 1, 24 * 14, DEFAULT_CONFIG.retryHours, 'retryHours', warnings)
  const retentionYears = integerInRange(input.retentionYears, 0, 5, DEFAULT_CONFIG.retentionYears, 'retentionYears', warnings)

  let debugNow = null
  if (typeof input.debugNow === 'string' && input.debugNow.length > 0) {
    const parsed = new Date(input.debugNow)
    if (Number.isNaN(parsed.getTime())) warnings.push(`debugNow is not a valid date: ${input.debugNow}`)
    else debugNow = parsed.toISOString()
  } else if (input.debugNow !== undefined && input.debugNow !== null) {
    warnings.push('debugNow must be an ISO date string or null')
  }

  const config = {
    enabled,
    timeZone,
    peakWindows,
    weekendOffPeak,
    showPriceHint,
    pauseOnPeakCrossing,
    dataDir,
    updateEnabled,
    updateUrls,
    allowInsecureUpdate,
    updateTimeoutMs,
    blockingUpdateMs,
    updateCheckIntervalMinutes,
    nextCheckHours,
    retryHours,
    retentionYears,
    extraHolidays,
    extraHolidaySet: new Set(extraHolidays),
    debugNow,
    debugForceUpdate,
    debugForcePause,
  }
  return { config, warnings }
}

function booleanOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function integerInRange(value, min, max, fallback, name, warnings) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    warnings.push(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}; using ${fallback}`)
    return fallback
  }
  return value
}

function validateTimeZone(value, warnings) {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_CONFIG.timeZone
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone
    return resolved
  } catch {
    warnings.push(`timeZone ${JSON.stringify(candidate)} is not supported; using ${DEFAULT_CONFIG.timeZone}`)
    return DEFAULT_CONFIG.timeZone
  }
}

function normalizeWindows(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_WINDOWS.map((window) => ({ ...window }))
  if (!Array.isArray(value)) {
    warnings.push('peakWindows must be an array; using defaults')
    return DEFAULT_WINDOWS.map((window) => ({ ...window }))
  }
  const windows = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      warnings.push(`ignoring invalid peak window ${JSON.stringify(item)}`)
      continue
    }
    const start = typeof item.start === 'string' ? item.start.trim() : ''
    const end = typeof item.end === 'string' ? item.end.trim() : ''
    const startMatch = HHMM.exec(start)
    const endMatch = HHMM.exec(end)
    if (startMatch === null || endMatch === null) {
      warnings.push(`ignoring peak window with invalid HH:mm bounds: ${JSON.stringify(item)}`)
      continue
    }
    const startMinutes = Number(startMatch[1]) * 60 + Number(startMatch[2])
    const endMinutes = Number(endMatch[1]) * 60 + Number(endMatch[2])
    if (startMinutes === endMinutes) {
      warnings.push(`ignoring zero-length peak window ${start}-${end}`)
      continue
    }
    windows.push({
      start,
      end,
      startMinutes,
      endMinutes,
      label: `${start}–${end}`,
    })
  }
  if (windows.length === 0) {
    warnings.push('no valid peakWindows; using defaults')
    return DEFAULT_WINDOWS.map((window) => ({ ...window }))
  }
  windows.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes)
  return windows
}

function normalizeHolidayList(value, warnings) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push('extraHolidays must be an array of YYYY-MM-DD dates')
    return []
  }
  const dates = []
  for (const item of value) {
    if (typeof item !== 'string' || !DATE_KEY.test(item)) {
      warnings.push(`ignoring invalid extraHolidays date ${JSON.stringify(item)}`)
      continue
    }
    dates.push(item)
  }
  return [...new Set(dates)].sort()
}

function normalizeUrls(value, warnings) {
  const list = Array.isArray(value) ? value : DEFAULT_CONFIG.updateUrls
  const urls = []
  for (const item of list) {
    if (typeof item !== 'string' || !item.includes('{year}')) {
      warnings.push(`ignoring update URL without {year}: ${JSON.stringify(item)}`)
      continue
    }
    urls.push(item)
  }
  if (urls.length === 0) {
    warnings.push('no valid updateUrls; using the default timor.tech endpoint')
    return [...DEFAULT_CONFIG.updateUrls]
  }
  return urls
}

/** Format one non-negative minute count as compact Chinese duration text. */
export function formatDuration(minutes) {
  const total = Math.max(1, Math.ceil(minutes))
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (hours === 0) return `${rest} 分钟`
  if (rest === 0) return `${hours} 小时`
  return `${hours} 小时 ${rest} 分钟`
}

/** Truncate a one-line summary to at most 120 Unicode code points. */
export function truncateSummary(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  if (points.length <= max) return flat
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** Read one date's fields in a fixed IANA zone (UTC+8 fallback for Asia/Shanghai). */
export function getDateParts(date, timeZone = DEFAULT_CONFIG.timeZone) {
  const instant = date instanceof Date ? date : new Date(date)
  try {
    const formatter = formatterFor(timeZone)
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]))
    const hour = Number(parts.hour) % 24
    const minute = Number(parts.minute)
    const weekdayIndex = WEEKDAY_INDEX[parts.weekday]
    if (weekdayIndex === undefined) throw new Error(`unknown weekday ${parts.weekday}`)
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      weekdayIndex,
      hour,
      minute,
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      timeText: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    }
  } catch {
    const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    const year = shifted.getUTCFullYear()
    const month = shifted.getUTCMonth() + 1
    const day = shifted.getUTCDate()
    const hour = shifted.getUTCHours()
    const minute = shifted.getUTCMinutes()
    return {
      year,
      month,
      day,
      weekdayIndex: shifted.getUTCDay(),
      hour,
      minute,
      dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      timeText: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    }
  }
}

function formatterFor(timeZone) {
  const key = timeZone || DEFAULT_CONFIG.timeZone
  const cached = formatterCache.get(key)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: key,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(key, formatter)
  return formatter
}

/** Convert a weekday index to a Chinese label. */
export function weekdayLabel(index) {
  return WEEKDAY_LABELS[index] ?? '未知'
}

function windowContains(window, minuteOfDay) {
  if (window.startMinutes < window.endMinutes) {
    return minuteOfDay >= window.startMinutes && minuteOfDay < window.endMinutes
  }
  return minuteOfDay >= window.startMinutes || minuteOfDay < window.endMinutes
}

function windowRemaining(window, minuteOfDay) {
  let remaining = window.endMinutes - minuteOfDay
  if (remaining <= 0) remaining += 24 * 60
  return remaining
}

/**
 * Resolve the current peak status.
 * @param {Date} date
 * @param {object} config - normalized config
 * @param {object|null} holidayData - data.js store
 */
export function resolvePeakState(date, config, holidayData = null) {
  const parts = getDateParts(date, config.timeZone)
  const weekday = weekdayLabel(parts.weekdayIndex)
  const year = parts.year
  const yearKey = String(year)
  const yearData = holidayData?.years?.[yearKey]
  const holidays = Array.isArray(yearData?.holidays) ? yearData.holidays : []
  const isHoliday = holidays.includes(parts.dateKey) || config.extraHolidaySet?.has(parts.dateKey) === true
  const state = {
    peak: false,
    reason: 'outside',
    window: null,
    windowKey: null,
    remainingMinutes: null,
    weekday,
    weekdayIndex: parts.weekdayIndex,
    timeText: parts.timeText,
    dateKey: parts.dateKey,
    year,
    month: parts.month,
    hour: parts.hour,
    minute: parts.minute,
    yearStatus: yearData?.status ?? 'unknown',
    coverageThrough: holidayData?.coverageThrough ?? null,
  }

  if (config.weekendOffPeak && (parts.weekdayIndex === 0 || parts.weekdayIndex === 6)) {
    return { ...state, reason: 'weekend' }
  }
  if (isHoliday) return { ...state, reason: 'holiday' }

  const minuteOfDay = parts.hour * 60 + parts.minute
  for (const window of config.peakWindows) {
    if (!windowContains(window, minuteOfDay)) continue
    return {
      ...state,
      peak: true,
      reason: 'window',
      window,
      windowKey: `${parts.dateKey}:${window.start}-${window.end}`,
      remainingMinutes: windowRemaining(window, minuteOfDay),
    }
  }
  return state
}

/** Build the normal peak reminder shown when a turn starts during peak. */
export function formatReminder(state, config, options = {}) {
  const zone = timeZoneLabel(config.timeZone)
  const window = state.window
  let head = `⏰ 高峰时段提醒：现在是${state.weekday} ${state.timeText}（${zone}），处于模型调用高峰时段（${window.start}–${window.end}），距空闲时段（${window.end} 起）还有 ${formatDuration(state.remainingMinutes)}。`
  if (config.showPriceHint) head += '高峰时段单价约为空闲时段的 2 倍。'
  if (options.incompleteYear) {
    head += `（${options.incompleteYear} 年节假日数据尚未更新，按工作日规则判断）`
  }
  const summary = truncateSummary(head)
  const text = `${head}\n（这是插件自动插入的提醒，用户已看到；它不是用户的问题，请忽略本提醒，继续回答用户上一条消息。）`
  return { summary, text }
}

/** Human label for the configured display zone. */
export function timeZoneLabel(timeZone) {
  if (timeZone === 'Asia/Shanghai') return '北京时间'
  if (timeZone === 'UTC') return 'UTC'
  return timeZone
}

/** Whether a year's holiday data is complete. */
export function yearIsComplete(state) {
  return state.yearStatus === 'complete'
}
