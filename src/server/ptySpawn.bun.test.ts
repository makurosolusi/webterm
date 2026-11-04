// Bun-only: spawn nyata + jalur gagal spawn.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPty } from './pty'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(get: () => string, needle: string, maxMs = 5000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline && !get().includes(needle)) await sleep(50)
}

test('spawn yang melempar menjadi pesan terbaca lalu exit, bukan throw', async () => {
  let out = ''
  let code: number | undefined
  const pty = spawnPty({ cols: 80, rows: 24 }, () => { throw new Error('boom: no such shell') })
  pty.onData((d) => { out += d })
  pty.onExit((c) => { code = c })
  await sleep(20)
  expect(out).toContain('[webterm] failed to start shell: boom: no such shell')
  expect(code).toBe(127)
  pty.write('x')
  pty.resize(10, 10)
  pty.kill()
})

test('shell biasa: login shell, env terminal-like, tanpa bocoran env server', async () => {
  process.env.NODE_ENV = 'production'
  process.env.PORT = '1234'
  // Temp HOME: a `bash -l` reading the user's real rc files (brew/pyenv/nvm/conda) took > 5 s under
  // load, the test hit bun's 5 s default and left the shell for bun's dangling-process kill.
  const originalHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'webterm-ptyspawn-'))
  process.env.HOME = home
  let out = ''
  const pty = spawnPty({ cols: 80, rows: 24, cwd: '/definitely/not/here', shell: '/bin/bash' })
  try {
    pty.onData((d) => { out += d })
    pty.write('shopt -q login_shell && L=yes; echo "login=[$L] tp=$TERM_PROGRAM ct=$COLORTERM ne=[$NODE_ENV] port=[$PORT] cwd=$(pwd -P)"; echo END_$((40+2))\n')
    await until(() => out, 'END_42', 15_000)
    expect(out).toContain('login=[yes]')
    expect(out).toContain('tp=webterm ct=truecolor ne=[] port=[]')
    expect(out).toContain(`cwd=${realpathSync(home)}`)
  } finally {
    pty.kill()
    process.env.HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
