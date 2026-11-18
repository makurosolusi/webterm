// Konteks + helper bersama verb agent (validasi body, panggilan CDP via allowlist). Dipisah agar `.read`/`.act` tidak siklik.
import { TEXT_MAX_BYTES } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserState, BrowserVerb, VerbData } from '../../shared/browser.contract'
import { callAllowed } from './browserAgent.cdpAllowlist'
import type { SnapshotStore } from './browserAgent.snapshot'
import { BrowserError } from './browserHost.targets'
import type { LeaseService } from './browserLease.service'
import type { ConsoleLog } from './browserHost.console'

export interface ApprovalRequest { nodeId: string; verb: 'click'; hostname: string }

export interface AgentCtx {
  host: BrowserHostApi
  leases: LeaseService
  snapshots: SnapshotStore
  /** Gabungan flag fitur + `WEBTERM_BROWSER_AGENT` + toggle `agentControl` node. */
  agentAllowed(nodeId: string): boolean
  /** Persetujuan manusia (P-10) untuk aksi konsekuensial lintas-origin; absen = ditolak. */
  approve?(req: ApprovalRequest): Promise<boolean>
  /** Rebuild a `discarded` node's page at `url` through the MAX_LIVE gate (`lifecycle.attach`); throws `BlockedError('max_live')` when full. */
  wake?(nodeId: string, url: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  /** Console buffer of the host (verb `console`); absent = the verb answers `disabled`. */
  console?: Pick<ConsoleLog, 'read' | 'capture'>
}

/** Verbs on an existing browser node; `open` has no node yet, the control handler serves it (`browser.agentOpen.ts`). */
export type AgentVerbs = { [V in Exclude<BrowserVerb, 'open'>]: (nodeId: string, body: unknown) => Promise<VerbData[V]> }

/** The verbs on the node's page (`createAgentVerbs`); `tabs`/`tab` need the host's tab API and are added by `withTabs` (browser.agentTabs.verbs.ts). */
export type BaseVerbs = Omit<AgentVerbs, 'tabs' | 'tab'>

export const badRequest = (msg: string) => new BrowserError('bad_request', msg)

/** Body harus objek biasa. */
export function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('body must be a JSON object')
  return body as Record<string, unknown>
}

/** String non-kosong dengan batas byte. */
export function needString(v: unknown, field: string, maxBytes = TEXT_MAX_BYTES): string {
  if (typeof v !== 'string' || v === '' || Buffer.byteLength(v) > maxBytes) throw badRequest(`${field} must be a non-empty string (max ${maxBytes} bytes)`)
  return v
}

/** Panggil CDP lewat allowlist; galat protokol "node hilang" dipetakan ke `stale_ref`, selain itu diteruskan. */
export async function domCall<T = Record<string, unknown>>(ctx: AgentCtx, nodeId: string, method: string, params: object = {}): Promise<T> {
  try {
    return (await callAllowed(ctx.host, nodeId, method, params)) as T
  } catch (err) {
    if (err instanceof Error && !(err instanceof BrowserError) && /\) failed:/.test(err.message)) {
      throw new BrowserError('stale_ref', `node ${nodeId}: element no longer available`, undefined, err)
    }
    throw err
  }
}

export function stateOf(ctx: AgentCtx, nodeId: string): BrowserState {
  const s = ctx.host.state(nodeId)
  if (!s) throw new BrowserError('not_found', `browser node ${nodeId} not found`)
  return s
}
