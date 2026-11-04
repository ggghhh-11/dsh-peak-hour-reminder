import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyWindowState, loadWindowState, saveWindowState, windowStatePath } from '../lib/state.js'

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'peak-state-'))
  return { dir, config: { dataDir: dir } }
}

test('missing state starts empty', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(loadWindowState(config), emptyWindowState())
  assert.ok(windowStatePath(config).startsWith(dir))
})

test('state round-trips accepted and paused windows', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  saveWindowState(config, {
    schemaVersion: 1,
    acceptedWindowKey: '2026-11-04:14:00-18:00',
    acceptedAt: '2026-11-04T07:46:00.000Z',
    pausedWindowKey: null,
    pausedAt: null,
  })
  const loaded = loadWindowState(config)
  assert.equal(loaded.acceptedWindowKey, '2026-11-04:14:00-18:00')
  assert.equal(loaded.acceptedAt, '2026-11-04T07:46:00.000Z')
  assert.equal(loaded.pausedWindowKey, null)
  assert.match(readFileSync(windowStatePath(config), 'utf8'), /acceptedWindowKey/)
})

test('corrupt state falls back to empty', (t) => {
  const { dir, config } = tempConfig()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(windowStatePath(config), '{not-json', 'utf8')
  assert.deepEqual(loadWindowState(config), emptyWindowState())
})
