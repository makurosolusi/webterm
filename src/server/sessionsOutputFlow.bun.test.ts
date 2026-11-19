// Bun-only: every payload shape a remote `ls` could produce must reach the subscriber through the
// REAL server path (PTY -> UTF-8 stream decode -> OutputLog -> subscribers), with and without the
// tmux supervisor (private socket, never the user's sessions). Reproduction harness for "output
// stalls and the prompt never returns" (no ssh needed: the remote only matters through its bytes).
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
afterAll(() => reapChildren())
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-flow-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR // the user's shell rc is not under test

import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { TmuxSupervisor } from './ptySupervisor'

const SOCKET = `webterm-flow-${process.pid}`
const sup = new TmuxSupervisor(SOCKET)

afterAll(() => {
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* server already gone */ }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, SOCKET), { force: true })
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(25)
  }
}

const ESC = '\x1b'
const names = ['日本語のファイル', '🎉party🎉', 'zero​width‍name', 'مرحبا', 'é́́', 'plain']
const PAYLOADS: Record<string, string> = {
  'two megabytes of ascii': ('x'.repeat(99) + '\n').repeat(20_000),
  'many short lines': Array.from({ length: 60_000 }, (_, i) => `l${i}`).join('\n') + '\n',
  'emoji cjk zero-width names in columns': Array.from({ length: 4000 }, (_, i) => names[i % names.length]!.padEnd(30)).join('  ') + '\n',
  'multibyte straddling chunk edges': '🎉'.repeat(150_000) + '\n',
  'unterminated osc dcs apc': `${ESC}]0;never ended${ESC}P1$r${ESC}_Gaaaa\n`,
  'sgr and box drawing at width': Array.from({ length: 3000 }, () => `${ESC}[1;38;5;196m┌${'─'.repeat(70)}┐${ESC}[0m`).join('\n') + '\n',
}

async function run(label: string, session: Sessions, id: string, payload: string): Promise<void> {
  const file = join(DATA_DIR, `${id}.payload`)
  writeFileSync(file, payload)
  const out: string[] = []
  session.open({ t: 'open', id, cols: 100, rows: 30 }, (m: ServerMsg) => { if (m.t === 'output') out.push(m.data) })
  await sleep(300)
  session.input(id, `cat ${file}; echo END-$((20+22))\r`)
  await until(() => out.join('').includes('END-42'), `${label}: end marker (got ${out.join('').length} chars)`)
  // macOS ttys occasionally emit `\r\r\n` at a 1 KiB read boundary (kernel, harmless to xterm); fold every CR run.
  const got = out.join('').replace(/\r+\n/g, '\n')
  // Direct PTY keeps every byte; tmux redraws the screen, so only the marker is comparable there.
  if (!sessionIsSupervised(session)) expect(got.includes(payload)).toBe(true)
  session.close(id)
}
const sessionIsSupervised = (s: Sessions): boolean => (s as unknown as { supervisor: unknown }).supervisor !== null

for (const [name, payload] of Object.entries(PAYLOADS)) {
  test(`direct PTY delivers every byte: ${name}`, async () => {
    await run(name, new Sessions({ shell: '/bin/sh' }), `d-${name.length}`, payload)
  }, 60000)
  // tmux is itself a terminal emulator: an unterminated OSC/DCS/APC string swallows what follows, exactly as xterm would.
  if (name.startsWith('unterminated')) continue
  test(`tmux-supervised PTY reaches the end marker: ${name}`, async () => {
    await run(name, new Sessions({ shell: '/bin/sh' }, sup), `t-${name.length}`, payload)
  }, 60000)
}
