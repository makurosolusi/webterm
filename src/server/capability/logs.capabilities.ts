// `logs.query` / `logs.summary` (`webterm logs.query --json '{...}'`): read-only, scoped view of the server log for an
// agent session, so it never has to ask the user for a screenshot of an error. Runs in-process (dispatched from
// cli.exec `execute`, scoping in logs/logAgentQuery.ts); `route` is the `/api/tools/<name>` path that reaches it.
import { LOG_LEVELS } from '../../shared/logEntry'
import { AGENT_LOG_MAX_ROWS } from '../logs/logAgentQuery'
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S } from './capability.schema'
import { principalKind, type Grant, type Principal } from '../policy/policy.model'

export const LOGS_QUERY_CAPABILITY = 'logs.query'
export const LOGS_SUMMARY_CAPABILITY = 'logs.summary'
export const LOGS_CAPABILITY_NAMES: readonly string[] = [LOGS_QUERY_CAPABILITY, LOGS_SUMMARY_CAPABILITY]

// cli.launcher TOOLS_PATH; not imported because cli.registry imports this file and cli.launcher imports cli.registry.
const TOOLS_PATH = '/api/tools'

export const LOGS_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: LOGS_QUERY_CAPABILITY, summary: 'Read recent server logs: warn/error everywhere, every level for your node and the nodes wired to it.',
    tier: 'R0', scope: 'global', idempotent: true, projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${LOGS_QUERY_CAPABILITY}` },
    input: obj({
      channel: S.str(200, { description: 'Channel or parent, e.g. browser.page, browser.ssrf, pty.' }),
      level: { ...S.oneOf(...LOG_LEVELS), description: 'Minimum level. Default warn (info when `node` is given).' },
      since: S.str(8, { description: 'Window like 90s, 10m, 2h, 1d.' }),
      node: S.str(128, { description: 'Only entries about this node id.' }),
      event: S.str(200, { description: 'Event name or prefix, e.g. browser.ssrf.' }),
      q: S.str(200, { description: 'Case-insensitive text in channel/event/message.' }),
      limit: S.int(1, AGENT_LOG_MAX_ROWS),
    }),
    output: S.keys('entries', 'matched', 'truncated'),
  }),
  defineCapability({
    name: LOGS_SUMMARY_CAPABILITY, summary: 'Diagnose first: counts, grouped page/network failures with plain-language hints, and the server events behind them.',
    tier: 'R0', scope: 'global', idempotent: true, projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${LOGS_SUMMARY_CAPABILITY}` },
    input: obj({
      node: S.str(128, { description: 'Narrow to one node (e.g. the browser node that shows the error).' }),
      since: S.str(8, { description: 'Window like 90s, 10m, 2h, 1d. Default 10m.' }),
    }),
    output: S.keys('pageFailures', 'serverEvents', 'diagnosis'),
  }),
]

/** Every agent node may read logs (builtin slot: a human rule written later wins, last match). */
export const logsByDefault = (principal: Principal): Grant[] => principalKind(principal) !== 'node' ? [] : LOGS_CAPABILITY_NAMES.map((capability) => ({
  id: `agent-logs-default-${capability}`, subject: principal, capability, scope: '*', effect: 'allow' as const,
  expiresAt: null, origin: 'builtin' as const, createdBy: 'human-ui', createdAt: 0,
}))
