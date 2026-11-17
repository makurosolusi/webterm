// `skills.list` / `skills.propose` (`webterm skills list|propose|edit`): any agent session reads the skill library and
// PROPOSES a new skill or a new version. Proposals enter the Central skill store as drafts; approving, enabling,
// disabling and rejecting stay human-only. Runs in-process (dispatched from cli.exec `execute`, handler
// central/ca2Routes.agentSkill.ts); `route` is the `/api/tools/<name>` path that reaches it. Field limits are
// checked by the handler (human-route error codes), so the schema only pins types.
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S } from './capability.schema'
import { principalKind, type Grant, type Principal } from '../policy/policy.model'

export const SKILL_LIST_CAPABILITY = 'skills.list'
export const SKILL_PROPOSE_CAPABILITY = 'skills.propose'
export const SKILL_CAPABILITY_NAMES: readonly string[] = [SKILL_LIST_CAPABILITY, SKILL_PROPOSE_CAPABILITY]

// cli.launcher TOOLS_PATH; not imported because cli.registry imports this file and cli.launcher imports cli.registry.
const TOOLS_PATH = '/api/tools'

export const SKILL_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: SKILL_LIST_CAPABILITY, summary: 'List skills made for canvas agents (audience canvas) + your drafts; `name` adds the body.',
    tier: 'R0', scope: 'global', idempotent: true, projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${SKILL_LIST_CAPABILITY}` },
    input: obj({ name: S.str(undefined, { description: 'Optional: return the body of this ACTIVE canvas skill too.' }) }),
    output: S.keys('items'),
  }),
  defineCapability({
    name: SKILL_PROPOSE_CAPABILITY, summary: 'Propose a new skill, or (edit) a new version of an existing one; a human must approve it.',
    tier: 'R1', scope: 'global', projections: ['control-http'], route: { method: 'POST', path: `${TOOLS_PATH}/${SKILL_PROPOSE_CAPABILITY}` },
    input: obj({
      name: S.str(undefined, { description: 'webterm-<slug>; the name of an active skill proposes a new version.' }),
      description: S.str(undefined, { description: 'One line: what it does and when to use it.' }),
      body: S.str(undefined, { description: 'Skill instructions (markdown).' }),
      caps: S.arr(S.any()),
      audience: S.str(undefined, { description: 'Optional; agents can only write `canvas` skills (central is refused with audience_forbidden). An edit keeps the audience.' }),
      edit: S.bool(),
    }, ['name']),
    output: S.keys('name', 'version', 'state'),
  }),
]

/** Every agent node may read the library and propose (builtin slot: a human rule written later wins, last match). */
export const skillsByDefault = (principal: Principal): Grant[] => principalKind(principal) !== 'node' ? [] : SKILL_CAPABILITY_NAMES.map((capability) => ({
  id: `agent-skills-default-${capability}`, subject: principal, capability, scope: '*', effect: 'allow' as const,
  expiresAt: null, origin: 'builtin' as const, createdBy: 'human-ui', createdAt: 0,
}))
