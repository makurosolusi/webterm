// Verb agent (PLAN b §4.6): satu fungsi per verb, semua body divalidasi (batas kepercayaan), semua akses CDP lewat
// `callAllowed`. Dibagi `.read` (status/snapshot/screenshot/wait) dan `.act` (navigate/click/type/press/scroll).
import type { AgentCtx, BaseVerbs } from './browserAgent.verbs.ctx'
import { stateOf } from './browserAgent.verbs.ctx'
import { actVerbs } from './browserAgent.verbs.act'
import { readVerbs } from './browserAgent.verbs.read'
import { consoleVerbs } from './browserAgent.verbs.console'
import { timed } from './browserAgent.latency'

export type { AgentCtx, AgentVerbs, ApprovalRequest, BaseVerbs } from './browserAgent.verbs.ctx'

const urlOf = (body: unknown): string | undefined => {
  const u = (body as { url?: unknown } | null | undefined)?.url
  return typeof u === 'string' ? u : undefined
}

/** Single timing point: every verb runs through `timed` (latency buffer; host only, never the body). */
function timedVerbs(verbs: BaseVerbs): BaseVerbs {
  const out: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(verbs) as [string, (nodeId: string, body: unknown) => Promise<unknown>][]) {
    out[name] = (nodeId: string, body: unknown) => timed(name, () => fn(nodeId, body), { url: urlOf(body) })
  }
  return out as BaseVerbs
}

/** Rakit seluruh verb: read + act + handoff/release (lease). */
export function createAgentVerbs(ctx: AgentCtx): BaseVerbs {
  return timedVerbs({
    ...readVerbs(ctx),
    ...consoleVerbs(ctx),
    ...actVerbs(ctx),
    async handoff(nodeId) {
      stateOf(ctx, nodeId)
      return ctx.leases.acquire(nodeId, ctx.agentAllowed(nodeId), ctx.sleep)
    },
    async release(nodeId) {
      ctx.leases.release(nodeId)
      return { lease: 'human' }
    },
  })
}
