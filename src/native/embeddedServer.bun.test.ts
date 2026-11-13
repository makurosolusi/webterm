// The native app's in-process server: started on a chosen loopback port it answers, hands its
// one-time sign-in file to the host (not the OS browser), and after stop() the port is free again
// while the process is still alive (the listener really closed, not the process exiting) and the
// SQLite stores are closed.
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapChildren } from '../server/processReap.testutil'
import { freeLoopbackPort, LOOPBACK_HOST } from './embeddedServer'

const MODULE = join(import.meta.dirname, 'embeddedServer.ts')
const STEP_TIMEOUT_MS = 20_000
const children: ChildProcess[] = []
afterAll(() => { children.forEach((c) => c.kill()); return reapChildren() })

// Child: start in-process, print what the host would see, stop on a `stop` line from the test.
const CHILD = `
import { startEmbeddedServer } from ${JSON.stringify(MODULE)}
const s = await startEmbeddedServer({ port: Number(process.env.EMBED_PORT), openFile: async (p) => console.log('OPEN ' + p) })
console.log('READY ' + s.url)
await s.openUi()
for await (const line of console) if (line === 'stop') { await s.stop(); console.log('STOPPED') }
`

/** Resolves with the first stdout line starting with `prefix` (rest of the line). */
function lineFrom(proc: ChildProcess, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`no "${prefix}" line in time; stdout: ${buf}`)), STEP_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const hit = buf.split('\n').find((l) => l.startsWith(prefix))
      if (hit !== undefined) { clearTimeout(timer); resolve(hit.slice(prefix.length)) }
    })
  })
}

const canBind = (port: number): Promise<boolean> => new Promise((resolve) => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(port, LOOPBACK_HOST, () => probe.close(() => resolve(true)))
})

test('starts on the chosen loopback port, answers, opens through the host, stops and frees the port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-embed-'))
  const port = await freeLoopbackPort()
  const proc = spawn(process.execPath, ['--no-env-file', '-e', CHILD], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, WEBTERM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), NODE_ENV: 'test', EMBED_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  children.push(proc)
  const opened = lineFrom(proc, 'OPEN ')

  expect(await lineFrom(proc, 'READY ')).toBe(`http://${LOOPBACK_HOST}:${port}`)
  // The host's window would load this file; it redirects to the URL that trades the code for the UI cookie.
  const file = await opened
  expect(file).not.toContain('code=') // the host (and Electrobun's loadURL log) only ever sees the path
  const signIn = /url=([^"]+)"/.exec(readFileSync(file, 'utf8'))![1]!.replace(/&amp;/g, '&')
  expect(signIn.startsWith(`http://${LOOPBACK_HOST}:${port}/auth/open?code=`)).toBe(true)
  const open = await fetch(signIn, { redirect: 'manual' })
  expect(open.status).toBe(303)
  const cookie = open.headers.get('set-cookie')?.split(';')[0] ?? ''
  expect(cookie.startsWith('wt_ui=')).toBe(true)
  expect((await fetch(`http://${LOOPBACK_HOST}:${port}/api/health`, { headers: { cookie } })).status).toBe(200)
  expect(await canBind(port)).toBe(false)

  const stopped = lineFrom(proc, 'STOPPED')
  proc.stdin?.write('stop\n')
  await stopped
  expect(proc.exitCode).toBeNull() // still running: the port was freed by stop(), not by exiting
  expect(await canBind(port)).toBe(true)
  // Stores closed by stop() itself (a native quit skips the `exit` hook), once each.
  const logDir = join(dir, 'data', 'logs')
  const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
  expect([...logs.matchAll(/Closed (webterm\.db|ledger\.db)/g)].map((m) => m[1])).toEqual(['webterm.db', 'ledger.db'])
}, 3 * STEP_TIMEOUT_MS)
