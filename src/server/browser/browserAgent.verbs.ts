// Verb agent (PLAN b §4.6): satu fungsi per verb, semua body divalidasi (batas kepercayaan), semua akses CDP lewat
// `callAllowed`. Dibagi `.read` (status/snapshot/screenshot/wait) dan `.act` (navigate/click/type/press/scroll).
import type { AgentCtx, AgentVerbs } from './browserAgent.verbs.ctx'
import { stateOf } from './browserAgent.verbs.ctx'
import { actVerbs } from './browserAgent.verbs.act'
import { readVerbs } from './browserAgent.verbs.read'
import { consoleVerbs } from './browserAgent.verbs.console'

export type { AgentCtx, AgentVerbs, ApprovalRequest } from './browserAgent.verbs.ctx'

/** Rakit seluruh verb: read + act + handoff/release (lease). */
export function createAgentVerbs(ctx: AgentCtx): AgentVerbs {
  return {
    ...readVerbs(ctx),
    ...consoleVerbs(ctx),
    ...actVerbs(ctx),
    async handoff(nodeId) {
      stateOf(ctx, nodeId)
      return ctx.leases.handoff(nodeId, ctx.agentAllowed(nodeId))
    },
    async release(nodeId) {
      ctx.leases.release(nodeId)
      return { lease: 'human' }
    },
  }
}
