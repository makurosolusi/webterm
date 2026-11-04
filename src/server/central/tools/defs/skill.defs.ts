// Central skill tools: list/load are R0, propose is R1. There is deliberately no activate/approve/rollback tool:
// activation is a human R3 action on the admin store (skillLifecycle), never reachable from a model.
import { flagOn } from '../../../envFlag'
import type { SkillProposeInput, SkillRecord, SkillStatus, SkillStore } from '../../contracts/skill.types'
import type { Awaitable } from '../../contracts/tool.types'
import { SkillError } from '../../skills/skillIndex'
import type { ToolCtx, ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { APPROVAL_NESTED_FORBIDDEN } from '../toolValidate'
import { obj, S } from '../../../capability/capability.schema'

export const SKILLS_FLAG = 'WEBTERM_CENTRAL_SKILLS'
export const SKILL_PROPOSE_FLAG = 'WEBTERM_CENTRAL_SKILL_PROPOSE'
export const SKILL_LIST_DEFAULT = 20
export const SKILL_LIST_MAX = 50
const STATUSES: readonly SkillStatus[] = ['proposed', 'rejected', 'evaluated', 'pending_approval', 'active', 'disabled', 'archived']

/** Store shape the tools need: the contract plus paginated list. */
export type SkillToolStore = SkillStore & { list(status?: SkillStatus, page?: { limit?: number; offset?: number }): Awaitable<readonly SkillRecord[]> }
/** Resolves the store for one call; WS-19 supplies it (data dir + db live in boot wiring). */
export type SkillStoreResolver = (ctx: ToolCtx) => SkillToolStore

const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const isInt = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
// `status` is a legal filter here, so only the authority keys are forbidden (approvedBy, actor, token, ...).
const forbidden = (input: ToolInput): boolean => Object.keys(input).some((k) => APPROVAL_NESTED_FORBIDDEN.has(k))
const flagged = (ctx: ToolCtx, flag: string): boolean => flagOn((ctx.env ?? process.env)[flag])

function failure(err: unknown): ToolResult {
  if (err instanceof SkillError) return { ok: false, code: err.code, data: err.issues.length ? { issues: [...err.issues] } : {} }
  throw err
}

/** Builds the three skill tool definitions over a store resolver. */
export function createSkillDefs(resolve: SkillStoreResolver): readonly ToolDef[] {
  const list: ToolDef = {
    name: 'skill.list', summary: 'List skills (name, version, status, origin), newest first, paginated.', tier: 'R0', flag: SKILLS_FLAG, projectScoped: false, forbidden,
    usage: `{"status":"active|proposed|...","limit":<=${SKILL_LIST_MAX},"offset":0}; all fields optional.`,
    input: obj({ status: S.str(), limit: S.int(1, SKILL_LIST_MAX), offset: S.int(0) }),
    output: S.keys('skills'),
    validate: (input) => (onlyKeys(input, ['status', 'limit', 'offset']) && (input.status === undefined || STATUSES.includes(input.status as SkillStatus)) && (input.limit === undefined || isInt(input.limit, 1, SKILL_LIST_MAX)) && (input.offset === undefined || isInt(input.offset, 0, 1_000_000)) ? null : 'invalid_shape'),
    async handler(ctx, input): Promise<ToolResult> {
      const records = await resolve(ctx).list(input.status as SkillStatus | undefined, { limit: (input.limit as number | undefined) ?? SKILL_LIST_DEFAULT, offset: (input.offset as number | undefined) ?? 0 })
      return { ok: true, data: { skills: records.map((r) => ({ name: r.name, version: r.version, status: r.status, origin: r.origin })) } }
    },
  }
  const load: ToolDef = {
    name: 'skill.load', summary: 'Load the body of an active webterm-* skill (hash-verified).', tier: 'R0', flag: SKILLS_FLAG, projectScoped: false, forbidden,
    usage: '{"name":"webterm-<slug>"}. Returns the skill body; a skill that is not active or fails its hash check is not_found.',
    input: obj({ name: S.str(64) }, ['name']),
    output: S.keys('name', 'version', 'body'),
    auditKeys: ['name', 'version'],
    validate: (input) => (onlyKeys(input, ['name']) && typeof input.name === 'string' && input.name.length <= 64 ? null : 'invalid_shape'),
    async handler(ctx, input): Promise<ToolResult> {
      const content = await resolve(ctx).load(input.name as string)
      return content ? { ok: true, data: { name: content.record.name, version: content.record.version, body: content.body } } : { ok: false, code: 'not_found' }
    },
  }
  const propose: ToolDef = {
    name: 'skill.propose', summary: 'Propose a new skill draft for human review; never activates it.', tier: 'R1', flag: SKILL_PROPOSE_FLAG, projectScoped: false, forbidden,
    usage: '{"name":"webterm-<slug>","description":"<=300 chars, what + when","body":"<=4000 chars markdown instructions","caps":["tool.verb"]}. Instructions only: no commands, URLs, paths or secrets. A human must approve before it is usable.',
    input: obj({ name: S.str(), description: S.str(), body: S.str(), caps: S.arr(S.str()) }, ['name', 'description', 'body', 'caps']),
    output: S.keys('name', 'version', 'status'),
    auditKeys: ['name', 'version', 'status'],
    validate: (input) => (onlyKeys(input, ['name', 'description', 'body', 'caps']) && typeof input.name === 'string' && typeof input.description === 'string' && typeof input.body === 'string' && Array.isArray(input.caps) && input.caps.every((c) => typeof c === 'string') ? null : 'invalid_shape'),
    async handler(ctx, input): Promise<ToolResult> {
      if (!flagged(ctx, SKILLS_FLAG)) return { ok: false, code: 'flag_off' }
      try {
        const rec = await resolve(ctx).propose(input as unknown as SkillProposeInput, `central:${ctx.conversationId}`)
        return { ok: true, data: { name: rec.name, version: rec.version, status: rec.status } }
      } catch (err) { return failure(err) }
    },
  }
  return [list, load, propose]
}
