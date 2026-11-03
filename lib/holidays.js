/**
 * Built-in holiday baseline. This is only a seed / corrupt-file fallback; the
 * runtime store lives in $DSH_HOME/peak-hour-reminder/holidays.json and is
 * refreshed from the configured holiday endpoint.
 *
 * Sources:
 * - 2026: 国务院办公厅关于2026年部分节假日安排的通知
 *   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * - 2027: only New Year (2027-01-01..03) is confirmed as of 2026-11-03;
 *   the rest must wait for the official notice and is filled by auto-update
 *   or `extraHolidays`.
 */

function daysInclusive(start, end) {
  const dates = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

export const BUILTIN_DATA = Object.freeze({
  schemaVersion: 1,
  updatedAt: '2026-11-03T00:00:00+08:00',
  coverageThrough: 2026,
  years: {
    2026: {
      status: 'complete',
      source: 'builtin:gov.cn-2026',
      fetchedAt: '2026-11-03T00:00:00+08:00',
      holidays: [
        ...daysInclusive('2026-01-01', '2026-01-03'),
        ...daysInclusive('2026-02-15', '2026-02-23'),
        ...daysInclusive('2026-04-04', '2026-04-06'),
        ...daysInclusive('2026-05-01', '2026-05-05'),
        ...daysInclusive('2026-06-19', '2026-06-21'),
        ...daysInclusive('2026-09-25', '2026-09-27'),
        ...daysInclusive('2026-10-01', '2026-10-07'),
      ],
    },
    2027: {
      status: 'partial',
      source: 'builtin:known-new-year',
      fetchedAt: '2026-11-03T00:00:00+08:00',
      holidays: daysInclusive('2027-01-01', '2027-01-03'),
    },
  },
  lastAttemptAt: null,
  nextCheckAt: null,
  lastError: null,
})

/** Latest year whose holiday list is complete in the built-in baseline. */
export const BUILTIN_COVERAGE_THROUGH = 2026

/** Countries/regions are fixed for now; the schema is ready for more. */
export const HOLIDAY_REGION = 'CN'
