// Bun-only: tmux client di dalam PTY Bun nyata. Socket test SENDIRI (`webterm-test-<pid>`), jadi
// sesi `-L webterm` (pengguna) dan `-L node-terminal` (nodeterm) tidak pernah tersentuh.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-supervisor-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR // shell rc pengguna tidak ikut diuji (dan tidak memperlambat start)
// Token root di env server: tidak boleh sampai ke pane walau server tmux dimulai dari proses ini.
process.env.WEBTERM_TOKEN = 'root-secret-test-only' // test-only

import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { TMUX_MISSING_NOTICE, TmuxSupervisor, bootSupervisor, nodeIdOf, supervisedName, supervisorSocket, tmuxArg } from './ptySupervisor'
import type { Pty } from './pty'

const SOCKET = `webterm-test-${process.pid}`
const sup = new TmuxSupervisor(SOCKET)

afterAll(() => {
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* server sudah keluar sendiri */ }
  // tmux 3.7 meninggalkan file socket-nya sesudah server keluar (terukur); punya test, jadi dibuang.
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, SOCKET), { force: true })
  process.env.HOME = ORIGINAL_HOME
  delete process.env.WEBTERM_TOKEN
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(50)
  }
}
const open = (s: Sessions, id: string, send: (m: ServerMsg) => void = () => {}) =>
  s.open({ t: 'open', id, cols: 80, rows: 24 }, send)
const supervised = () => new Sessions({ shell: '/bin/sh' }, sup)

test('nama sesi bisa dibalik, termasuk id pane split ber-`:`', () => {
  for (const id of ['n1', 'a:p1', 'a_p1']) expect(nodeIdOf(supervisedName(id))).toBe(id)
  expect(supervisedName('a:p1')).not.toBe(supervisedName('a_p1'))
  expect(nodeIdOf('nt-term-abc')).toBeNull() // sesi nodeterm bukan milik kita
})

test('`;` di akhir argumen di-escape supaya tmux tidak memotongnya', () => {
  expect(tmuxArg('echo hi;')).toBe('echo hi\\;')
  expect(tmuxArg('a;b')).toBe('a;b')
})

test('socket per data dir; default polos `webterm`, bukan `node-terminal`', () => {
  expect(supervisorSocket(undefined)).toBe('webterm')
  expect(supervisorSocket('/x')).toMatch(/^webterm-[0-9a-f]{8}$/)
  expect(supervisorSocket('/x')).not.toBe(supervisorSocket('/y'))
})

test('sesi selamat dari restart server: shell sama, output lanjut, input jalan, scrollback utuh', async () => {
  const before = supervised()
  open(before, 'r1')
  await until(() => sup.has('r1'), 'session created')
  // 40 baris > 24 baris layar: `line-1` sudah bergulir ke history tmux saat restart.
  before.input('r1', 'KEEP=alive; i=1; while [ $i -le 40 ]; do echo "line-$i"; i=$((i+1)); done; echo "pre-$((40+2))"\r')
  await until(() => before.getTerminal('r1').includes('pre-42'), 'pre-restart output')
  // Echo perintah memuat `$((40+2))`, bukan `42`: yang dicari hanya bisa datang dari shell.

  // "Restart": client tmux milik server lama mati (seperti saat proses Bun mati), sesinya tidak.
  process.kill(before.pidOf('r1')!, 'SIGKILL')
  await until(() => !before.isLive('r1'), 'old client gone')
  expect(sup.has('r1')).toBe(true)

  const after = supervised()
  expect(after.adoptSupervised().adopted).toEqual(['r1'])
  expect(after.isLive('r1')).toBe(true)

  // Browser menyambung ulang: replay langsung memuat history dari SEBELUM restart (seed), lalu tmux
  // menggambar ulang layarnya sendiri.
  const replay: string[] = []
  open(after, 'r1', (m) => { if (m.t === 'output') replay.push(m.data) })
  expect(replay.join('')).toContain('line-1\r\n')
  await until(() => replay.join('').includes('pre-42'), 'screen redrawn after re-attach')
  expect(after.getTerminal('r1')).toContain('line-1\n')

  after.input('r1', 'echo "$KEEP-$((2+3))"\r')
  await until(() => after.getTerminal('r1').includes('alive-5'), 'post-restart output from the same shell')
  after.close('r1')
  await until(() => !sup.has('r1'), 'session killed')
})

test('close mengakhiri sesi tmux, bukan cuma client-nya', async () => {
  const s = supervised()
  open(s, 'c1')
  await until(() => sup.has('c1'), 'session created')
  s.close('c1')
  await until(() => !sup.has('c1'), 'session killed by close')
  expect(s.isLive('c1')).toBe(false)
})

test('sesi tanpa node workspace ditandai yatim dan tidak ditempeli', async () => {
  const s = supervised()
  open(s, 'o1')
  open(s, 'k1')
  await until(() => sup.has('o1') && sup.has('k1'), 'sessions created')
  process.kill(s.pidOf('o1')!, 'SIGKILL')
  process.kill(s.pidOf('k1')!, 'SIGKILL')
  await until(() => !s.isLive('o1') && !s.isLive('k1'), 'clients gone')

  const after = supervised()
  const res = after.adoptSupervised((id) => id === 'k1')
  expect(res).toEqual({ adopted: ['k1'], orphans: ['o1'] })
  expect(after.isLive('o1')).toBe(false)
  expect(sup.list().find((x) => x.id === 'o1')?.orphan).toBe(true)
  expect(sup.list().find((x) => x.id === 'k1')?.orphan).toBe(false)
  // Yatim tetap bisa ditutup (node dihapus): close tanpa entry map tetap membunuh sesinya.
  after.close('o1')
  after.close('k1')
  await until(() => !sup.has('o1') && !sup.has('k1'), 'sessions killed')
})

test('env pane tersaring: token root server tidak bocor ke sesi tmux', async () => {
  const s = supervised()
  open(s, 'e1')
  await until(() => sup.has('e1'), 'session created')
  s.input('e1', 'echo "[tok:${WEBTERM_TOKEN:-none}]"\r')
  await until(() => s.getTerminal('e1').includes('[tok:none]'), 'filtered env')
  expect(s.getTerminal('e1')).not.toContain('root-secret')
  s.close('e1')
  await until(() => !sup.has('e1'), 'session killed')
})

test('agent id disimpan di sesi supaya boot berikutnya tahu node agent', async () => {
  const s = supervised()
  s.open({ t: 'open', id: 'a1', cols: 90, rows: 30, cmd: 'sleep 30', agentId: 'claude' }, () => {})
  await until(() => sup.has('a1'), 'session created')
  const found = sup.list().find((x) => x.id === 'a1')
  expect(found?.agentId).toBe('claude')
  expect([found?.cols, found?.rows]).toEqual([90, 30])
  s.close('a1')
  await until(() => !sup.has('a1'), 'session killed')
})

test('fallback tanpa tmux: tanpa supervisor, dengan notice terlihat sekali', () => {
  expect(bootSupervisor({ NODE_ENV: 'test' }, () => '/usr/bin/tmux')).toEqual({ supervisor: null })
  const missing = bootSupervisor({}, () => undefined)
  expect(missing.supervisor).toBeNull()
  expect(missing.notice).toBe(TMUX_MISSING_NOTICE)
  expect(bootSupervisor({}, () => '/usr/bin/tmux').supervisor?.socket).toBe('webterm')

  const fake = (): Pty => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} })
  const s = new Sessions({ spawn: fake }, null)
  s.supervisorNotice = missing.notice
  const out = (id: string) => {
    const got: string[] = []
    open(s, id, (m) => { if (m.t === 'output') got.push(m.data) })
    return got.join('')
  }
  expect(out('f1')).toContain('tmux not found')
  expect(out('f2')).not.toContain('tmux not found')
})

test('the tmux-missing notice is plain ASCII English product text', () => {
  expect(TMUX_MISSING_NOTICE).toMatch(/^[\x20-\x7e\r\n]+$/)
  expect(TMUX_MISSING_NOTICE).toContain('[webterm] tmux not found: this session will end when the webterm server restarts.')
})

test('close then an immediate re-open of the same id gets a NEW live session, not the dying one', async () => {
  const s = new Sessions({ shell: '/bin/sh' }, sup)
  s.open({ t: 'open', id: 'b1', cols: 80, rows: 24, cmd: 'sleep 100' }, () => {})
  await until(() => sup.has('b1'), 'first session created')
  const pane = () => {
    try {
      return execFileSync('tmux', ['-L', SOCKET, 'display-message', '-p', '-t', `=${supervisedName('b1')}:`, '#{pane_pid}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return '' // no such session yet: the poll below keeps waiting
    }
  }
  const firstPane = pane()
  s.close('b1')
  s.open({ t: 'open', id: 'b1', cols: 80, rows: 24, cmd: 'sleep 100' }, () => {})
  // Poll instead of a fixed sleep (slow under full-suite load), then hold: the old bug showed the
  // view going dead once the dying client's exit landed, so it must stay live after it settles.
  await until(() => s.isLive('b1') && pane() !== '' && pane() !== firstPane, 'new live session')
  await sleep(500)
  expect(s.isLive('b1')).toBe(true)
  expect(sup.has('b1')).toBe(true)
  s.close('b1')
}, 20_000)

test('a plain open never attaches to a not-yet-adopted agent tmux session under its id', async () => {
  const agent = new Sessions({ shell: '/bin/sh' }, sup)
  agent.open({ t: 'open', id: 'k2', cols: 80, rows: 24, cmd: 'sleep 100', agentId: 'codex' }, () => {})
  await until(() => sup.has('k2'), 'agent session created')
  expect(sup.holder('k2')).toEqual({ agentId: 'codex' })
  expect(sup.holder('never-made')).toBeNull()
  const restarted = new Sessions({ shell: '/bin/sh' }, sup) // server restart, adoption not run yet
  const got: ServerMsg[] = []
  restarted.open({ t: 'open', id: 'k2', cols: 80, rows: 24 }, (m) => got.push(m))
  expect(restarted.isLive('k2')).toBe(false)
  expect(got.map((m) => m.t)).toEqual(['output', 'exit'])
  expect(got[1]).toMatchObject({ t: 'exit', reason: 'kind_mismatch' })
  agent.close('k2')
})
