// One server per data dir (instanceGuard.ts): a live, answering record refuses the start before any DB or port;
// a dead pid, a live pid that does not answer, and this process's own pid are all ignored.
import { afterAll, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALREADY_RUNNING_EXIT_CODE, AlreadyRunningError, assertSoleServer } from './instanceGuard'
import { INSTANCE_FILE, type InstanceRecord } from './instanceFile'

const HOST = '127.0.0.1' // test-only
const ENTRY = join(import.meta.dirname, 'index.ts')
const STEP_TIMEOUT_MS = 20_000
const OTHER_PID = -1 // test-only: never a real pid, so the record is never "ours"

// This test process plays the other live server: alive (its own pid) and answering any request.
const answeringServer = createHttpServer((_req, res) => res.end('ok'))
const hanging: Server[] = []
afterAll(() => { answeringServer.closeAllConnections(); answeringServer.close(); hanging.forEach((s) => s.close()) })

function tempDataDir(rec?: InstanceRecord): { dir: string; data: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wt-guard-'))
  const data = join(dir, 'data')
  mkdirSync(join(data, 'run'), { recursive: true, mode: 0o700 })
  if (rec) writeFileSync(join(data, 'run', INSTANCE_FILE), JSON.stringify(rec), { mode: 0o600 })
  return { dir, data }
}

async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve) })
  return (server.address() as AddressInfo).port
}

const answering = { port: await listenOn(answeringServer) }

async function freePort(): Promise<number> {
  const s = createServer()
  const port = await listenOn(s)
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test('a live, answering server for the data dir: the entry exits 1 with one line, before any DB or port', async () => {
  const t = tempDataDir({ pid: process.pid, host: HOST, port: answering.port })
  const port = await freePort()
  // test-only: every path temp, never the real ~/.webterm-server or ~/.claude
  const env = { PATH: process.env.PATH ?? '', HOME: t.dir, WEBTERM_DATA_DIR: t.data, CLAUDE_CONFIG_DIR: join(t.dir, 'claude'), HOST, PORT: String(port), NODE_ENV: 'test' }
  const proc = spawn(process.execPath, ['--no-env-file', ENTRY], { cwd: t.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  for (const s of [proc.stdout, proc.stderr]) s.on('data', (c: Buffer) => void (out += c.toString()))
  const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve))
  expect(code).toBe(ALREADY_RUNNING_EXIT_CODE)
  expect(out.trim()).toBe(`webterm is already running for ${t.data} on http://${HOST}:${answering.port} (pid ${process.pid}). Open that one, or set WEBTERM_DATA_DIR to run another.`)
  expect(existsSync(join(t.data, 'webterm.db'))).toBe(false)
  expect(existsSync(join(t.data, 'secrets'))).toBe(false) // no token minted either
  const probe = createServer()
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, HOST, resolve) }) // its port was never bound
  probe.close()
}, STEP_TIMEOUT_MS)

test('a live, answering record of another process: refused in-process with AlreadyRunningError', async () => {
  const t = tempDataDir({ pid: process.pid, host: HOST, port: answering.port })
  const err = await assertSoleServer(t.data, OTHER_PID).catch((e: unknown) => e)
  expect(err instanceof AlreadyRunningError).toBe(true)
  expect((err as AlreadyRunningError).pid).toBe(process.pid)
})

test('no record, or one that is not a record: starts', async () => {
  expect(await assertSoleServer(tempDataDir().data, OTHER_PID)).toBe(undefined)
  const t = tempDataDir()
  writeFileSync(join(t.data, 'run', INSTANCE_FILE), '{"pid":')
  expect(await assertSoleServer(t.data, OTHER_PID)).toBe(undefined)
})

test('a stale record (its process is dead): starts', async () => {
  const dead = spawnSync('true').pid // exited and reaped: nothing runs under this pid now
  expect(await assertSoleServer(tempDataDir({ pid: dead, host: HOST, port: answering.port }).data, OTHER_PID)).toBe(undefined)
})

test('a live pid that does not answer (nothing listens there): starts', async () => {
  expect(await assertSoleServer(tempDataDir({ pid: process.pid, host: HOST, port: await freePort() }).data, OTHER_PID)).toBe(undefined)
})

test('a live pid whose port accepts but never answers: starts after the answer timeout', async () => {
  const s = createServer(() => {}) // accepts TCP, never writes a response
  hanging.push(s)
  const port = await listenOn(s)
  expect(await assertSoleServer(tempDataDir({ pid: process.pid, host: HOST, port }).data, OTHER_PID)).toBe(undefined)
}, STEP_TIMEOUT_MS)

test('the record names this very process (pid reused after a crash): starts', async () => {
  expect(await assertSoleServer(tempDataDir({ pid: process.pid, host: HOST, port: answering.port }).data)).toBe(undefined)
})
