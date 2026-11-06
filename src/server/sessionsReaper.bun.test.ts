// Bun-only: real tmux on a PRIVATE socket (`webterm-reap-<pid>`), never `-L webterm` or the user's
// sessions. Locks the two-phase orphan reaper (ops-212-3 / pty-207-3) and the status re-seed (A4).
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-reap-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR // the user's shell rc is not under test

import { Sessions } from './sessions'
import { ORPHAN_REAP_GRACE_MS } from './sessionsAdopt'
import { CANVAS_OWNER, TmuxSupervisor } from './ptySupervisor'
import { StatusStore } from './sessionsStatusStore'

const SOCKET = `webterm-reap-${process.pid}`
const sup = new TmuxSupervisor(SOCKET)
const kills: string[] = []
const realKill = sup.kill.bind(sup)
sup.kill = (id: string) => { kills.push(id); realKill(id) }

afterAll(() => {
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* server already gone */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, SOCKET), { force: true })
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const T0 = 1_700_000_000_000 // test-only clock
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(50)
  }
}
const at = (now: number) => new Sessions({ shell: '/bin/sh', now: () => now }, sup)
const meta = (id: string) => sup.list().find((x) => x.id === id)
/** The server process dies: its tmux clients go, the sessions stay. */
async function crash(s: Sessions, ids: string[]): Promise<void> {
  s.statusStore = undefined // a dead process writes nothing on its way out
  for (const id of ids) process.kill(s.pidOf(id)!, 'SIGKILL')
  await until(() => ids.every((id) => !s.isLive(id)), 'clients gone')
}

test('a canvas orphan is ended once, a grace after its first mark; owned and untagged sessions live on', async () => {
  const s0 = at(T0)
  s0.handle({ t: 'open', id: 'ro', cols: 80, rows: 24 }, () => {}) // canvas, no node will own it
  s0.handle({ t: 'open', id: 'rk', cols: 80, rows: 24 }, () => {}) // canvas, owned again later
  s0.open({ t: 'open', id: 'ru', cols: 80, rows: 24 }, () => {}) // untagged (central agent, legacy)
  await until(() => ['ro', 'rk', 'ru'].every((id) => sup.has(id)), 'sessions created')
  expect(meta('ro')?.owner).toBe(CANVAS_OWNER)
  expect(meta('ru')?.owner).toBe(undefined)
  await crash(s0, ['ro', 'rk', 'ru'])

  // Boot 1: nobody owns anything yet. Everything is marked, nothing is ended.
  const b1 = at(T0).adoptSupervised(() => false)
  expect(b1.reaped).toEqual([])
  expect(meta('ro')?.orphanAt).toBe(T0)
  expect(meta('rk')?.orphanAt).toBe(T0)

  // Boot 2, inside the grace: `rk` is owned again and its mark is cleared; `ro` keeps its FIRST mark.
  const s2 = at(T0 + ORPHAN_REAP_GRACE_MS - 1)
  const b2 = s2.adoptSupervised((id) => id === 'rk')
  expect(b2).toEqual({ adopted: ['rk'], orphans: expect.arrayContaining(['ro', 'ru']), reaped: [] })
  expect(meta('ro')?.orphanAt).toBe(T0)
  expect(meta('rk')?.orphanAt).toBe(undefined)
  await crash(s2, ['rk'])

  // Boot 3 and 4, past the grace: only the canvas orphan ends, and only once.
  expect(at(T0 + ORPHAN_REAP_GRACE_MS).adoptSupervised((id) => id === 'rk').reaped).toEqual(['ro'])
  const s4 = at(T0 + 2 * ORPHAN_REAP_GRACE_MS)
  expect(s4.adoptSupervised((id) => id === 'rk').reaped).toEqual([])
  expect(kills).toEqual(['ro'])
  expect(sup.has('ro')).toBe(false)
  expect(sup.has('rk')).toBe(true)
  expect(sup.has('ru')).toBe(true)
  s4.close('rk')
  s4.close('ru')
  await until(() => !sup.has('rk') && !sup.has('ru'), 'sessions killed')
}, 60_000)

test('a restart re-seeds the last status of an adopted node (A4)', async () => {
  const store = new StatusStore(join(DATA_DIR, 'node-status.json'))
  const s1 = at(T0)
  s1.statusStore = store
  s1.open({ t: 'open', id: 'st1', cols: 80, rows: 24 }, () => {})
  await until(() => sup.has('st1'), 'session created')
  s1.setStatus('st1', 'waiting')
  await crash(s1, ['st1'])

  const s2 = at(T0 + 1)
  s2.statusStore = store
  expect(s2.statusOf('st1')).toBe(undefined)
  expect(s2.adoptSupervised(() => true).adopted).toEqual(['st1'])
  expect(s2.statusOf('st1')).toBe('waiting')
  s2.close('st1')
  await until(() => !sup.has('st1'), 'session killed')
}, 60_000)
