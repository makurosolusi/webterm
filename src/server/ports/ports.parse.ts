// Pure parsers for the port scanner (no I/O, vitest-safe).
//
// Imitated from Orca (`/tmp/st/orca-src/src/main/ports/`):
// - `parseLsofListening` = `local-workspace-platform-port-scanner.ts:24-52` (`lsof -nP -iTCP
//   -sTCP:LISTEN -F pcnd` field records: `p` pid, `c` command, `n` address).
// - `parseAddressWithPort`, `parseProcAddress`, `connectHost`, `dedupe` =
//   `local-workspace-port-address.ts:3-71`; `parseProcNetTcp` = scanner `:75-91` (state `0A` = LISTEN).
// Modified: Orca attributes a listener to a worktree by its cwd/command line
// (`local-workspace-port-attribution.ts`); webterm attributes it to the PTY that spawned it, by
// walking the `ps` parent chain up to a session's root pid (`ownerOf`).

export interface RawListener {
  host: string
  port: number
  pid?: number
  processName?: string
}

/** Bind host -> host a browser connects to (wildcards become `localhost`). */
export function connectHost(host: string): string {
  return host === '*' || host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

function dedupe(ports: RawListener[]): RawListener[] {
  const seen = new Set<string>()
  return ports.filter((p) => {
    const key = `${connectHost(p.host)}:${p.port}:${p.pid ?? 'unknown'}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parseAddressWithPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim().replace(/\s+\(LISTEN\)$/i, '')
  const m = trimmed.match(/^\[([^\]]+)\]:(\d+)$/) ?? trimmed.match(/^(.+):(\d+)$/)
  if (!m) return null
  const port = Number.parseInt(m[2]!, 10)
  return port > 0 && port <= 65535 ? { host: m[1]!, port } : null
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output. */
export function parseLsofListening(output: string): RawListener[] {
  const ports: RawListener[] = []
  let pid: number | undefined
  let processName: string | undefined
  for (const line of output.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const n = Number.parseInt(value, 10)
      pid = Number.isFinite(n) ? n : undefined
      processName = undefined
    } else if (tag === 'c') processName = value
    else if (tag === 'n') {
      const a = parseAddressWithPort(value)
      if (a) ports.push({ pid, processName, ...a })
    }
  }
  return dedupe(ports)
}

/** One `/proc/net/tcp{,6}` local address (`0100007F:1F90`). */
export function parseProcAddress(hex: string): { host: string; port: number } | null {
  const [addr = '', portHex = ''] = hex.split(':')
  const port = Number.parseInt(portHex, 16)
  if (!Number.isFinite(port) || port === 0) return null
  if (addr.length === 8) return { host: [6, 4, 2, 0].map((i) => Number.parseInt(addr.slice(i, i + 2), 16)).join('.'), port }
  if (addr.length !== 32) return null
  if (addr === '0'.repeat(32)) return { host: '::', port }
  if (addr === '00000000000000000000000001000000') return { host: '::1', port }
  const groups: string[] = []
  for (let i = 0; i < 32; i += 8) {
    const c = addr.slice(i, i + 8)
    const r = c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4) + c.slice(0, 2)
    groups.push(r.slice(0, 4), r.slice(4, 8))
  }
  return { host: groups.map((g) => g.replace(/^0+/, '') || '0').join(':'), port }
}

/** Listening sockets of a `/proc/net/tcp` table with their inode (header row skipped). */
export function parseProcNetTcp(content: string): Array<{ host: string; port: number; inode: number }> {
  const out: Array<{ host: string; port: number; inode: number }> = []
  for (const line of content.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const a = parseProcAddress(f[1]!)
    const inode = Number.parseInt(f[9]!, 10)
    if (a && Number.isFinite(inode) && inode !== 0) out.push({ ...a, inode })
  }
  return out
}

/** `ps -A -o pid= -o ppid=` -> child pid -> parent pid. */
export function parsePsParents(output: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
    if (m) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** Max parent hops walked; a real tree is shallow, this only stops a corrupt/cyclic table. */
const MAX_DEPTH = 64

/** The value of the nearest ancestor (or `pid` itself) found in `roots`, else undefined. */
export function ownerOf<T>(pid: number, parents: ReadonlyMap<number, number>, roots: ReadonlyMap<number, T>): T | undefined {
  let cur: number | undefined = pid
  for (let i = 0; cur !== undefined && cur > 1 && i < MAX_DEPTH; i++) {
    const hit = roots.get(cur)
    if (hit !== undefined) return hit
    cur = parents.get(cur)
  }
  return undefined
}

/** `tmux list-panes -a -F '#{session_name}\t#{pane_pid}'` -> [session name, pane pid]. */
export function parseTmuxPanes(output: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const line of output.split('\n')) {
    const [name, pid] = line.split('\t')
    const n = Number(pid)
    if (name && Number.isInteger(n) && n > 1) out.push([name, n])
  }
  return out
}
