// Throwaway webterm server for the capability smoke: random port, temp data dir, the REAL HOME (so `claude`
// auth and the browser binary are found). The real data dir (~/.webterm-server) is never passed or read.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRY = join(import.meta.dirname, '..', 'src', 'server', 'index.ts')
const READY_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5_000
const POLL_MS = 150
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface SmokeServer {
  base: string
  port: number
  cwd: string
  /** Cookie header value of a signed-in UI session (agent-chat routes are UI-only). */
  cookie: string
  /** Root token header for the Central chat API. */
  token: string
  log: () => string
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  for (;;) {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const { port } = s.address() as AddressInfo
    await new Promise<void>((r) => s.close(() => r()))
    // The dev-server proxy binds port+1; take a pair that is free.
    const probe = createServer()
    const ok = await new Promise<boolean>((r) => { probe.once('error', () => r(false)); probe.listen(port + 1, '127.0.0.1', () => probe.close(() => r(true))) })
    if (ok) return port
  }
}

// Env of the child: ours minus every inherited WEBTERM_ / NODETERM_ variable (this may run inside a webterm agent), plus the smoke's own.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(WEBTERM|NODETERM)_/.test(k)) env[k] = v
  return { ...env, ...extra }
}

export async function startServer(): Promise<SmokeServer> {
  const root = mkdtempSync(join(tmpdir(), 'webterm-smoke-'))
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  const port = await freePort()
  const token = randomBytes(24).toString('base64url')
  let out = ''
  let proc: ChildProcess | undefined
  const stop = async (): Promise<void> => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const done = new Promise<void>((r) => proc!.once('exit', () => r()))
      proc.kill('SIGTERM')
      await Promise.race([done, sleep(STOP_GRACE_MS)])
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await done }
    }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    proc = spawn(process.execPath, ['--no-env-file', ENTRY], {
      cwd: join(import.meta.dirname, '..'),
      env: childEnv({ WEBTERM_DATA_DIR: join(root, 'data'), PORT: String(port), WEBTERM_TOKEN: token }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const s of [proc.stdout, proc.stderr]) s?.on('data', (c: Buffer) => void (out += c.toString()))
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`smoke server exited early (${proc.exitCode}): ${out.slice(-500)}`)
      if (Date.now() > deadline) throw new Error(`smoke server not ready in ${READY_TIMEOUT_MS} ms: ${out.slice(-500)}`)
      try { await fetch(`${base}/auth/me`); break } catch { await sleep(POLL_MS) }
    }
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    const set = login.headers.get('set-cookie') ?? ''
    const cookie = /^(wt_ui=[^;]+)/.exec(set)?.[1]
    if (login.status !== 204 || !cookie) throw new Error(`smoke server sign-in failed (HTTP ${login.status})`)
    return { base, port, cwd, cookie, token, log: () => out, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
