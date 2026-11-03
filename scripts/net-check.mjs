/**
 * Manual network smoke check: fetch the current official holiday year once and
 * print the parsed result. Not part of `npm test`; run with
 *   node scripts/net-check.mjs
 * to verify this machine can reach the configured endpoint.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { refreshHolidayData } from '../lib/update.js'
import { seedData } from '../lib/data.js'

const dir = mkdtempSync(join(tmpdir(), 'peak-net-check-'))
try {
  const result = await refreshHolidayData({
    data: seedData(),
    years: [2026],
    config: {
      dataDir: dir,
      timeZone: 'Asia/Shanghai',
      updateUrls: ['https://timor.tech/api/holiday/year/{year}'],
      updateTimeoutMs: 5000,
      nextCheckHours: 24,
      retryHours: 6,
      retentionYears: 1,
      allowInsecureUpdate: false,
    },
    now: new Date('2026-11-03T20:00:00+08:00'),
  })
  const year = result.data.years['2026']
  console.log(JSON.stringify({
    changed: result.changed,
    status: year?.status,
    holidays: year?.holidays?.length ?? 0,
    source: year?.source,
    results: result.results,
    lastError: result.data.lastError,
  }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
