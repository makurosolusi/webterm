// ops-212-7: SIGTERM on a real server closes webterm.db, then ledger.db, exactly once each (an explicit,
// logged step, not the runtime's exit-time finalizer), and the ledger WAL ends checkpointed. Linux
// SQLite deletes -wal/-shm on close; the macOS system SQLite keeps the WAL file, truncated to 0 bytes.
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapChildren } from './processReap.testutil'

const ENTRY = join(import.meta.dirname, 'index.ts')
const READY_TIMEOUT_MS = 15_000
const POLL_MS = 100
const SIGTERM_EXIT = 143
const children: ChildProcess[] = []
afterAll(() => { children.forEach((c) => c.kill()); return reapChildren() })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

test('SIGTERM closes webterm.db then ledger.db once each and leaves the ledger WAL checkpointed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-shutdown-'))
  const data = join(dir, 'data')
  const port = await freePort()
  const proc = spawn(process.execPath, ['--no-env-file', ENTRY], {
    cwd: dir, env: { HOME: dir, WEBTERM_DATA_DIR: data, PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  children.push(proc)
  const exit = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)))
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not come up in time')
    try { await fetch(`http://127.0.0.1:${port}/api/settings/env`); break } catch { await sleep(POLL_MS) }
  }
  const wal = join(data, 'ledger.db-wal')
  const walBytes = (): number => (existsSync(wal) ? statSync(wal).size : 0)
  expect(walBytes()).toBeGreaterThan(0) // the open ledger has un-checkpointed boot writes

  proc.kill('SIGTERM')
  expect(await Promise.race([exit, sleep(READY_TIMEOUT_MS).then(() => 'timeout')])).toBe(SIGTERM_EXIT)

  expect(walBytes()).toBe(0)
  const logDir = join(data, 'logs')
  const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
  const closed = [...logs.matchAll(/Closed (webterm\.db|ledger\.db)/g)].map((m) => m[1])
  expect(closed).toEqual(['webterm.db', 'ledger.db'])
}, 2 * READY_TIMEOUT_MS + 5_000)
