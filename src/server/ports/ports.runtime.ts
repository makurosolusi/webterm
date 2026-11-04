// Production wiring of the port scanner + its HTTP route. Started lazily (idempotent) by the first
// `GET /api/ports`, like the outbox: `db`/`sessions` pull bun:sqlite and the PTY, so they are
// imported dynamically and node-env tests never load them.
//
//   GET /api/ports[?workspace=<id>]  {ports: DetectedPort[]}   (read-only, any authenticated caller)
import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import { recordEvent } from '../events/producers'
import { parsePort } from '../serverConfig'
import { createLogger } from '../logs'
import { parseLsofListening, parseProcNetTcp, parsePsParents, parseTmuxPanes, type RawListener } from './ports.parse'
import { PortScanner, type PortScanDeps } from './ports.service'

export const PORTS_PATH = '/api/ports'
/** Server-side poll period; one `lsof` + one `ps` per tick, skipped while no PTY is live. */
export const PORT_SCAN_INTERVAL_MS = 5000
const COMMAND_TIMEOUT_MS = 4000
const MAX_BUFFER = 4 * 1024 * 1024

const log = createLogger('ports')
const run = promisify(execFile)
const sh = async (bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  (await run(bin, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env })).stdout

async function linuxListeners(): Promise<RawListener[]> {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'utf8').then(parseProcNetTcp, () => [])))
  const sockets = tables.flat()
  const inodes = new Map(sockets.map((s) => [s.inode, s]))
  const out: RawListener[] = []
  for (const dir of (await readdir('/proc').catch(() => [] as string[])).filter((d) => /^\d+$/.test(d))) {
    for (const fd of await readdir(`/proc/${dir}/fd`).catch(() => [] as string[])) {
      const m = (await readlink(`/proc/${dir}/fd/${fd}`).catch(() => '')).match(/^socket:\[(\d+)\]$/)
      const s = m && inodes.get(Number(m[1]))
      if (s) out.push({ host: s.host, port: s.port, pid: Number(dir) })
    }
  }
  return out
}

/** Every TCP listener on this machine with its pid. */
export async function listeners(): Promise<RawListener[]> {
  if (process.platform === 'linux') return linuxListeners()
  // `-b -w`: never block on dead network mounts (Orca `shared/lsof-nonblocking-args.ts`).
  // lsof exits 1 when nothing listens: that is an empty answer, not a failure.
  try { return parseLsofListening(await sh('lsof', ['-b', '-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])) }
  catch (e) { const out = (e as { stdout?: string }).stdout; if (typeof out === 'string') return parseLsofListening(out); throw e }
}

async function roots(): Promise<Map<number, string>> {
  const { sessions } = await import('../sessions')
  const map = new Map<number, string>()
  for (const s of sessions.list()) if (s.pid > 1) map.set(s.pid, s.id)
  // Supervised (tmux) sessions: the PTY pid is a tmux CLIENT; the shell is a child of the tmux
  // server, so the pane pid is the root. `list-panes` never starts a server.
  const sup = sessions.supervisor
  if (sup) {
    const { nodeIdOf } = await import('../ptySupervisor')
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(process.env.TMUX_TMPDIR ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR } : {}) }
    const out = await sh('tmux', ['-L', sup.socket, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], env).catch(() => '')
    for (const [name, pid] of parseTmuxPanes(out)) { const id = nodeIdOf(name); if (id) map.set(pid, id) }
  }
  return map
}

/** child pid -> parent pid for every process. */
export const psParents = async (): Promise<Map<number, number>> => parsePsParents(await sh('ps', ['-A', '-o', 'pid=', '-o', 'ppid=']))

let scanner: PortScanner | undefined

/** The process-wide scanner, polling from the first call on. `deps` is for tests. */
export async function startPortScanner(deps?: Partial<PortScanDeps>): Promise<PortScanner> {
  if (scanner) return scanner
  const { db } = await import('../db')
  const s = new PortScanner({
    listeners, roots, parents: psParents,
    workspaces: () => db.list(), record: recordEvent, selfPort: parsePort(process.env.PORT), ...deps,
  })
  scanner = s
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try { await s.scan() } catch (e) { log.warn('ports.scan.failed', 'port scan failed', { cause: e instanceof Error ? e.message : String(e) }) }
    finally { busy = false }
  }
  void tick()
  setInterval(() => void tick(), PORT_SCAN_INTERVAL_MS).unref?.()
  return s
}

type Result = { status: number; body: unknown } | null

export async function portsRoute(path: string, method: string, query: URLSearchParams, start: () => Promise<PortScanner> = startPortScanner): Promise<Result> {
  if (path !== PORTS_PATH) return null
  if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
  return { status: 200, body: { ports: (await start()).list(query.get('workspace') ?? undefined) } }
}
