// Port scanner: which TCP listeners belong to processes started from a webterm PTY, as
// `port.open` / `port.close` senses events and a per-workspace list for the status-bar chips.
//
// Imitated from Orca `src/main/ports/local-workspace-platform-port-scanner.ts:121-164` (darwin:
// `lsof -O -b -w -nP -iTCP -sTCP:LISTEN -F pcn`) and `:183-207` (linux: `/proc/net/tcp{,6}` +
// socket inode -> pid via `/proc/<pid>/fd`). Orca's renderer polls every 30 s
// (`WorkspacePortScanner.tsx:21`); here the server polls on its own clock, only while a PTY is live,
// so a dev server started a few seconds ago shows up without a UI round-trip.
import type { Pane, Workspace, WsNode } from '../../shared/workspace'
import type { AppendEventInput } from '../events/eventModel'
import { connectHost, ownerOf, type RawListener } from './ports.parse'

export interface DetectedPort {
  port: number
  /** Address the socket is bound to (`127.0.0.1`, `*`, `::1`, ...). */
  host: string
  /** URL a Browser node opens. */
  url: string
  pid?: number
  processName?: string
  nodeId: string
  workspaceId: string
  /** Node title (or kind) for the chip label. */
  nodeLabel: string
}

export interface PortScanDeps {
  listeners(): Promise<RawListener[]>
  /** child pid -> parent pid. */
  parents(): Promise<Map<number, number>>
  /** Root pid of every live PTY session -> session (pane) id. */
  roots(): Promise<Map<number, string>>
  workspaces(): Workspace[]
  record(input: AppendEventInput): void
  /** webterm's own port: never offered (the browser guard hard-denies it on loopback anyway). */
  selfPort: number
}

function leaves(p: Pane | undefined, rootId: string): string[] {
  if (!p) return [rootId]
  return 'id' in p ? [p.id] : [...leaves(p.a, rootId), ...leaves(p.b, rootId)]
}

/** Session (pane) id -> owning node and workspace. */
export function paneOwners(workspaces: readonly Workspace[]): Map<string, { ws: Workspace; node: WsNode }> {
  const out = new Map<string, { ws: Workspace; node: WsNode }>()
  for (const ws of workspaces) {
    for (const node of ws.nodes) {
      if (node.kind !== 'terminal' && node.kind !== 'agent') continue
      for (const id of leaves(node.panes, node.id)) out.set(id, { ws, node })
    }
  }
  return out
}

/** Bracket IPv6 literals for a URL host. */
const urlHost = (h: string): string => (h.includes(':') ? `[${h}]` : h)

export function portUrl(host: string, port: number): string {
  return `http://${urlHost(connectHost(host))}:${port}`
}

const keyOf = (p: DetectedPort): string => `${p.nodeId}:${p.port}`

export class PortScanner {
  private current = new Map<string, DetectedPort>()

  constructor(private deps: PortScanDeps) {}

  /** One scan: attribute listeners, emit open/close for the difference, return the new set. */
  async scan(): Promise<DetectedPort[]> {
    const roots = await this.deps.roots()
    const next = new Map<string, DetectedPort>()
    if (roots.size > 0) {
      const [listeners, parents] = await Promise.all([this.deps.listeners(), this.deps.parents()])
      const owners = paneOwners(this.deps.workspaces())
      for (const l of listeners) {
        if (l.pid === undefined || l.port === this.deps.selfPort) continue
        const sessionId = ownerOf(l.pid, parents, roots)
        const owner = sessionId === undefined ? undefined : owners.get(sessionId)
        if (!owner) continue
        const p: DetectedPort = {
          port: l.port, host: l.host, url: portUrl(l.host, l.port), pid: l.pid, processName: l.processName,
          nodeId: owner.node.id, workspaceId: owner.ws.id, nodeLabel: owner.node.title?.trim() || owner.node.kind,
        }
        // IPv4 + IPv6 binds of one server are one chip.
        if (!next.has(keyOf(p))) next.set(keyOf(p), p)
      }
    }
    for (const [k, p] of next) if (!this.current.has(k)) this.emit('port.open', p)
    for (const [k, p] of this.current) if (!next.has(k)) this.emit('port.close', p)
    this.current = next
    return [...next.values()]
  }

  /** Last scan's ports of one workspace (all when omitted), sorted by port. */
  list(workspaceId?: string): DetectedPort[] {
    return [...this.current.values()].filter((p) => !workspaceId || p.workspaceId === workspaceId).sort((a, b) => a.port - b.port)
  }

  private emit(kind: 'port.open' | 'port.close', p: DetectedPort): void {
    this.deps.record({
      kind,
      source: 'ports',
      actor: 'pty',
      subject: `node:${p.nodeId}`,
      nodeId: p.nodeId,
      workspaceId: p.workspaceId,
      trust: 'trusted',
      // Process NAME only: a command line can carry secrets (Rule 12).
      payload: { port: p.port, host: p.host, url: p.url, pid: p.pid, processName: p.processName },
    })
  }
}
