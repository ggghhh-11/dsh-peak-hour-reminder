/**
 * Durable window-acceptance state.
 *
 * One peak window at a time is enough:
 * - acceptedWindowKey: the user chose "continue" for this peak window;
 * - pausedWindowKey: the user chose "pause" and may resume with "继续".
 *
 * Stored next to holidays.json so a DSH restart does not re-ask inside the
 * same peak window. Global to the DSH instance (one user).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDataDir } from './data.js'

const SCHEMA_VERSION = 1

/** Absolute path of the window state file. */
export function windowStatePath(config) {
  return join(resolveDataDir(config), 'state.json')
}

/** Empty state. */
export function emptyWindowState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    acceptedWindowKey: null,
    acceptedAt: null,
    pausedWindowKey: null,
    pausedAt: null,
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Load the state; missing/corrupt files fall back to empty. */
export function loadWindowState(config) {
  const file = windowStatePath(config)
  try {
    if (!existsSync(file)) return emptyWindowState()
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('state must be an object')
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      acceptedWindowKey: stringOrNull(parsed.acceptedWindowKey),
      acceptedAt: stringOrNull(parsed.acceptedAt),
      pausedWindowKey: stringOrNull(parsed.pausedWindowKey),
      pausedAt: stringOrNull(parsed.pausedAt),
    }
  } catch (error) {
    console.warn(`[peak-hour-reminder] window state unreadable (${error instanceof Error ? error.message : String(error)}); starting fresh`)
    return emptyWindowState()
  }
}

/** Atomically persist the state. Throws on I/O failure. */
export function saveWindowState(config, state) {
  const file = windowStatePath(config)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
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
