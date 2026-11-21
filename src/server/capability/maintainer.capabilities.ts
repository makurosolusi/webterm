// `doctor.run` / `config.read` / `instance.info` (`webterm <name> --json '{...}'`): the read-only diagnosis half of the
// maintainer profile (docs/decisions/maintainer-agent.md, wave 1). `logs.query` / `logs.summary` live in logs.capabilities.ts.
// Reachable only by a node born with the `maintainer` preset (the stored node decides, an agent cannot claim it); runs
// in-process from cli.exec, so enforcement, receipts and agent-context are the same path as every other capability.
import type { Workspace } from '../../shared/workspace'
import { principalKind, type Grant, type Principal } from '../policy/policy.model'
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S, type JsonSchema } from './capability.schema'

export const DOCTOR_RUN_CAPABILITY = 'doctor.run'
export const CONFIG_READ_CAPABILITY = 'config.read'
export const INSTANCE_INFO_CAPABILITY = 'instance.info'
export const MAINTAINER_CAPABILITY_NAMES: readonly string[] = [DOCTOR_RUN_CAPABILITY, CONFIG_READ_CAPABILITY, INSTANCE_INFO_CAPABILITY]
/** Rows `config.read` returns at most (the registry has a few hundred keys; a filter narrows it). */
export const CONFIG_READ_MAX_ROWS = 100

// cli.launcher TOOLS_PATH; not imported because cli.registry imports this file and cli.launcher imports cli.registry.
const TOOLS_PATH = '/api/tools'
const read = (name: string, summary: string, input: JsonSchema, ...out: string[]): CapabilitySpec => defineCapability({
  name, summary, tier: 'R0', scope: 'global', idempotent: true, projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${name}` }, input, output: S.keys(...out),
})

export const MAINTAINER_CAPABILITIES: readonly CapabilitySpec[] = [
  read(DOCTOR_RUN_CAPABILITY, 'Run the Doctor health checks (read-only): id, status, plain-language finding, no secrets.',
    obj({ id: S.str(32, { description: 'Only this check (claude, tools, skills, telegram, ripgrep, tmux, sandbox, dataDir, ledger).' }) }), 'checks', 'summary'),
  read(CONFIG_READ_CAPABILITY, 'Read the effective non-secret configuration: key, value, source. Secrets show only set/unset.',
    obj({ q: S.str(100, { description: 'Case-insensitive text in the key or label.' }), limit: S.int(1, CONFIG_READ_MAX_ROWS) }), 'rows', 'matched', 'truncated'),
  read(INSTANCE_INFO_CAPABILITY, 'Instance facts: version, mode, platform, uptime, data dir present, session and node counts, browser status.', obj({}), 'version', 'mode', 'uptimeSec'),
]

/** True when the stored node `nodeId` was born with the maintainer preset (the workspace writer is the human; a node token cannot write it). */
export const isMaintainerNode = (board: readonly Workspace[], nodeId: string): boolean =>
  board.some((ws) => ws.nodes.some((n) => n.id === nodeId && n.preset === 'maintainer'))

/** Builtin allow for a node principal (slot below human rules: a human deny written later wins); the preset gate is `isMaintainerNode`. */
export const maintainerByDefault = (principal: Principal): Grant[] => principalKind(principal) !== 'node' ? [] : MAINTAINER_CAPABILITY_NAMES.map((capability) => ({
  id: `agent-maintainer-default-${capability}`, subject: principal, capability, scope: '*', effect: 'allow' as const,
  expiresAt: null, origin: 'builtin' as const, createdBy: 'human-ui', createdAt: 0,
}))
