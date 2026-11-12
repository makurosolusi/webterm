// `agent.report` (`webterm report "<text>" --done|--blocked|--question|--progress`): an agent session tells Central where
// its work stands, at any time, like a worker posting to its orchestrator. Runs in-process (dispatched from cli.exec
// `execute`, handler central/work/workAgentReport.ts); `route` is the `/api/tools/<name>` path that reaches it.
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S } from './capability.schema'
import { principalKind, type Grant, type Principal } from '../policy/policy.model'

export const AGENT_REPORT_CAPABILITY = 'agent.report'
export const AGENT_REPORT_KINDS = ['done', 'blocked', 'question', 'progress'] as const
export type AgentReportKind = (typeof AGENT_REPORT_KINDS)[number]
/** Cap of one report's text; at 4 bytes a char it still fits a mail body (8 KiB). */
export const REPORT_TEXT_MAX = 2000
/** At most this many reports per node per window, so one agent cannot flood Central. */
export const REPORT_RATE_MAX = 5
export const REPORT_RATE_WINDOW_MS = 60_000

// cli.launcher TOOLS_PATH; not imported because cli.registry imports this file and cli.launcher imports cli.registry.
const TOOLS_PATH = '/api/tools'

export const REPORT_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: AGENT_REPORT_CAPABILITY, summary: 'Report to Central now: done (result), blocked, a question, or progress; done/blocked/question wake it.',
    tier: 'R1', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${AGENT_REPORT_CAPABILITY}` },
    input: obj({
      text: S.str(undefined, { description: `The report, at most ${REPORT_TEXT_MAX} chars. For done: the result.` }),
      kind: { ...S.oneOf(...AGENT_REPORT_KINDS), description: 'done = finished (task goes to review), blocked / question = needs Central, progress = a note (wakes Central only if it asked).' },
    }, ['text', 'kind']),
    output: obj({ reportId: S.str(), kind: S.str(), taskId: { type: ['string', 'null'] }, moved: { type: ['string', 'null'] }, answeredAsk: S.bool(), mailId: { type: ['string', 'null'] } }),
  }),
]

/** Every agent node may report about its own work (builtin slot: a human rule written later wins, last match). */
export const reportByDefault = (principal: Principal): Grant[] => principalKind(principal) !== 'node' ? [] : [{
  id: 'agent-report-default', subject: principal, capability: AGENT_REPORT_CAPABILITY, scope: '*', effect: 'allow',
  expiresAt: null, origin: 'builtin', createdBy: 'human-ui', createdAt: 0,
}]
