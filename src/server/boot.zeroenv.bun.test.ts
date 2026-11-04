// Z1-Z9 (PLAN ENV-MINIMAL b2 §9): boot proses nyata dengan env KOSONG (hanya HOME, WEBTERM_DATA_DIR, PORT).
// Tiap kasus punya tmp HOME/data/cwd sendiri; semua anak dibunuh di afterAll. Nilai token tak pernah dicetak.
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapChildren } from './processReap.testutil'

const ENTRY = join(import.meta.dirname, 'index.ts')
const READY_TIMEOUT_MS = 15_000
const POLL_MS = 100
const TOKEN_LEN = 43 // base64url 32 byte, tanpa padding
const SENTINEL_ENV_TOKEN = 'ZENV'.repeat(10)
const SENTINEL_BAD_FILE = 'bad token sentinel with spaces'
const SENTINEL_BOT = 'sentinel-bot-value-xyz'
// Covers the slowest case (Z2+Z3 boots twice), so a server that never comes up fails with its own
// message instead of bun's 5 s default, and the child is never left running mid-test.
const BOOT_TEST_TIMEOUT_MS = 2 * READY_TIMEOUT_MS + 5_000
const children: ChildProcess[] = []
// Kill AND wait: an unawaited kill leaves the server for bun's own dangling-process kill (processReap.testutil.ts).
afterAll(() => { children.forEach((c) => c.kill()); return reapChildren() })

type Boot = { proc: ChildProcess; port: number; dir: string; data: string; out: () => string }

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const exited = (c: ChildProcess): Promise<number | null> => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve(c.exitCode) : new Promise((r) => c.once('exit', (code) => r(code))))

/** Spawn index.ts dengan env kosong + `extra`; `args` default `--no-env-file`. */
async function spawnServer(extra: Record<string, string>, opts: { dir?: string; args?: string[] } = {}): Promise<Boot> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'zeroenv-'))
  const data = join(dir, 'data')
  const port = await freePort()
  let text = ''
  const proc = spawn(process.execPath, [...(opts.args ?? ['--no-env-file']), ENTRY], {
    cwd: dir, env: { HOME: dir, WEBTERM_DATA_DIR: data, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(proc)
  for (const s of [proc.stdout, proc.stderr]) s?.on('data', (c: Buffer) => void (text += c.toString()))
  return { proc, port, dir, data, out: () => text }
}

async function untilUp(b: Boot): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.proc.exitCode !== null) throw new Error(`server exited early (${b.proc.exitCode})`)
    try { await fetch(`http://127.0.0.1:${b.port}/healthz-probe`); return } catch { await sleep(POLL_MS) }
  }
  throw new Error('server did not come up in time')
}

async function boot(extra: Record<string, string> = {}, opts: { dir?: string; args?: string[] } = {}): Promise<Boot> {
  const b = await spawnServer(extra, opts)
  await untilUp(b)
  return b
}

/** Kode keluar dalam batas waktu, atau gagal bila proses masih hidup. */
async function exitedWithin(b: Boot): Promise<number | null> {
  const code = await Promise.race([exited(b.proc), sleep(READY_TIMEOUT_MS).then(() => 'timeout' as const)])
  if (code === 'timeout') throw new Error('process did not exit in time')
  return code
}

/** GET mentah via TCP supaya header Host bisa dipalsukan (fetch melarangnya). */
function rawGet(port: number, host: string, extraHeaders = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const sock = connect(port, '127.0.0.1', () => sock.write(`GET /api/settings/env HTTP/1.1\r\nHost: ${host}\r\n${extraHeaders}Connection: close\r\n\r\n`))
    sock.on('data', (d) => void (buf += d.toString()))
    sock.on('error', reject)
    sock.on('close', () => resolve({ status: Number(buf.split(' ')[1]), body: buf.split('\r\n\r\n')[1] ?? '' }))
  })
}

const tokenPath = (data: string): string => join(data, 'secrets', 'WEBTERM_TOKEN')
const mode = (p: string): number => statSync(p).mode & 0o777
const api = (b: Boot, headers: Record<string, string> = {}): Promise<Response> => fetch(`http://127.0.0.1:${b.port}/api/settings/env`, { headers })

test('Z1 loopback tanpa env: naik terbuka, data 0700, db 0600, tanpa berkas token, stderr bersih', async () => {
  const b = await boot()
  expect((await api(b)).status).toBe(200)
  expect(mode(b.data)).toBe(0o700)
  expect(mode(join(b.data, 'webterm.db'))).toBe(0o600)
  expect(existsSync(tokenPath(b.data))).toBe(false)
  expect(b.out()).not.toMatch(/Error|EADDRINUSE|throw/)
}, BOOT_TEST_TIMEOUT_MS)

test('Z2+Z3 non-loopback: token berkas 0600/43, 401/403 tanpa token, token tak bocor; reboot memakai token sama', async () => {
  const b = await boot({ HOST: '0.0.0.0' })
  const p = tokenPath(b.data)
  const token = readFileSync(p, 'utf8').trim()
  expect(token.length).toBe(TOKEN_LEN)
  expect(mode(p)).toBe(0o600)
  expect([401, 403]).toContain((await api(b)).status)
  expect((await api(b, { 'x-webterm-token': token })).status).toBe(200)
  expect(b.out()).toContain(p)
  expect(b.out()).not.toContain(token)
  b.proc.kill()
  await exited(b.proc)
  const again = await boot({ HOST: '0.0.0.0' }, { dir: b.dir })
  expect(readFileSync(p, 'utf8').trim()).toBe(token)
  expect(again.out()).not.toContain(token)
}, BOOT_TEST_TIMEOUT_MS)

test('Z4 env menang: token env diterima, tanpa berkas token, sentinel tak muncul di keluaran', async () => {
  const b = await boot({ HOST: '0.0.0.0', WEBTERM_TOKEN: SENTINEL_ENV_TOKEN })
  expect((await api(b, { 'x-webterm-token': SENTINEL_ENV_TOKEN })).status).toBe(200)
  expect(existsSync(tokenPath(b.data))).toBe(false)
  expect(b.out()).not.toContain(SENTINEL_ENV_TOKEN)
}, BOOT_TEST_TIMEOUT_MS)

test('Z5 berkas token rusak: keluar non-nol, pesan memuat path tanpa isi, berkas tak ditimpa', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zeroenv-'))
  const p = tokenPath(join(dir, 'data'))
  mkdirSync(join(dir, 'data', 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(p, SENTINEL_BAD_FILE, { mode: 0o600 })
  const b = await spawnServer({ HOST: '0.0.0.0' }, { dir })
  expect(await exitedWithin(b)).not.toBe(0)
  expect(b.out()).toContain(p)
  expect(b.out()).not.toContain(SENTINEL_BAD_FILE)
  expect(readFileSync(p, 'utf8')).toBe(SENTINEL_BAD_FILE)
  // Tidak ada asersi "webterm.db belum dibuat": db.ts membuka DB saat impor, sebelum bootWiring jalan (dilaporkan sbg deviasi).
}, BOOT_TEST_TIMEOUT_MS)

test('Z6 PORT invalid: keluar non-nol dan pesan menyebut PORT="abc"', async () => {
  const b = await spawnServer({ PORT: 'abc' })
  expect(await exitedWithin(b)).not.toBe(0)
  expect(b.out()).toContain('PORT="abc"')
}, BOOT_TEST_TIMEOUT_MS)

test('Z7 rebinding: Host asing 403 host_not_allowed (Host tak dipantulkan), Host localhost 200', async () => {
  const b = await boot()
  const evil = await rawGet(b.port, `evil.example:${b.port}`, `Origin: http://evil.example:${b.port}\r\n`)
  expect(evil.status).toBe(403)
  expect(JSON.parse(evil.body)).toEqual({ error: 'host_not_allowed' })
  expect(evil.body).not.toContain('evil.example')
  expect((await rawGet(b.port, `localhost:${b.port}`)).status).toBe(200)
}, BOOT_TEST_TIMEOUT_MS)

// Adaptasi Z8: POST /api/settings/token/enable milik EM-15 (belum ada). Efek yang sama diuji lewat token berkas:
// begitu token ditegakkan, allowlist Host mati dan Host LAN + token benar diterima.
test('Z8 (adaptasi) token tegak => allowlist Host mati: Host 192.168.1.5 + token benar 200', async () => {
  const b = await boot({ HOST: '0.0.0.0' })
  const token = readFileSync(tokenPath(b.data), 'utf8').trim()
  const ok = await rawGet(b.port, `192.168.1.5:${b.port}`, `x-webterm-token: ${token}\r\n`)
  expect(ok.status).toBe(200)
}, BOOT_TEST_TIMEOUT_MS)

test('Z9 .env di cwd (tanpa --no-env-file): notis memuat nama kunci saja, sentinel tak muncul', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zeroenv-'))
  writeFileSync(join(dir, '.env'), `WEBTERM_LEDGER=on\nTELEGRAM_BOT_TOKEN=${SENTINEL_BOT}\n`)
  const b = await boot({}, { dir, args: [] })
  expect(b.out()).toContain('.env supplies registry keys')
  expect(b.out()).toContain('WEBTERM_LEDGER')
  expect(b.out()).not.toContain(SENTINEL_BOT)
}, BOOT_TEST_TIMEOUT_MS)
