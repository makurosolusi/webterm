// Bun-only: real tmux on a PRIVATE socket (`webterm-hist-<pid>`), never the user's sessions.
// Locks the scrollback a client gets after a server restart: the seeded tmux history must survive
// the first redraw instead of being evicted whole from the byte-capped output log.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
afterAll(() => reapChildren())
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-hist-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR // the user's shell rc is not under test

import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { TmuxSupervisor } from './ptySupervisor'

const SOCKET = `webterm-hist-${process.pid}`
const sup = new TmuxSupervisor(SOCKET)

afterAll(() => {
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* server already gone */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, SOCKET), { force: true })
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(50)
  }
}
const supervised = () => new Sessions({ shell: '/bin/sh' }, sup)
const LINES = 3000
const PAD = 'x'.repeat(100)

test('history seeded after a restart is not evicted whole by the first redraw', async () => {
  const before = supervised()
  before.open({ t: 'open', id: 'h1', cols: 80, rows: 24 }, () => {})
  await until(() => sup.has('h1'), 'session created')
  before.input('h1', `i=1; while [ $i -le ${LINES} ]; do echo "L$i ${PAD}"; i=$((i+1)); done; echo "done-$((1+1))"\r`)
  await until(() => before.getTerminal('h1').includes('done-2'), 'output finished')
  process.kill(before.pidOf('h1')!, 'SIGKILL') // the server dies; the tmux session stays
  await until(() => !before.isLive('h1'), 'old client gone')

  const after = supervised()
  expect(after.adoptSupervised().adopted).toEqual(['h1'])
  // A browser reconnects seconds after boot: tmux has already redrawn into the log by then.
  await until(() => after.getTerminal('h1').includes('done-2'), 'tmux redraw logged')
  await sleep(300)
  const replay: string[] = []
  after.open({ t: 'open', id: 'h1', cols: 80, rows: 24 }, (m: ServerMsg) => { if (m.t === 'output') replay.push(m.data) })
  const lines = replay.join('').split('\n').filter((l) => l.includes(PAD)).length
  // The default log cap (256 KiB) holds ~2500 of these lines; a single seed chunk used to be
  // evicted by the redraw, leaving only the ~24 screen rows.
  expect(lines).toBeGreaterThan(1500)
  after.close('h1')
  await until(() => !sup.has('h1'), 'session killed')
}, 60000)
