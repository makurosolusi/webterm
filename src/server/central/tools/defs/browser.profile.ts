// Browser profiles for Central's tools: the port over the profile registry, the shared "unknown profile" answer
// (it lists the names, so the model is never stuck) and `browser_profile` (list / create).
// Deliberately NO cookie import, export or delete here: cookies are sensitive, only the human manages them in the UI
// (docs/decisions/browser-profiles.md). A profile an agent creates is global (usable on every board) and leaves a
// bounded ledger note (kind `browser.profile`), never a permission card.
import type { BrowserProfile } from '../../../../shared/browser.profile'
import { WORKSPACE_HUES } from '../../../../shared/workspaceColor'
import { agentControlOn } from '../../../browser/browser.runtime.parts'
import { obj, S } from '../../../capability/capability.schema'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { browserNodesOf } from './browser.status'

/** Profile registry as the Central tools need it; production = `browser.profiles.service` (ca2Boot.browser.ts), faked in tests. */
export interface BrowserProfilePort {
  list(workspaceId: string): BrowserProfile[]
  /** By id or case-insensitive name. */
  resolve(ref: string, workspaceId: string): BrowserProfile | undefined
  /** Creates a global profile (the color is picked when absent); the service leaves the ledger note. */
  create(input: { name: string; color?: string }): { ok: true; profile: BrowserProfile } | { ok: false; code: string }
}

/** What a tool shows of a profile: id, name, color and use; never any cookie data. */
export const profileView = (p: BrowserProfile) => ({ id: p.id, name: p.name, color: p.color, live: p.live, nodeCount: p.nodeCount, default: p.isDefaultOf !== undefined })

const quoted = (list: readonly BrowserProfile[]): string => list.map((p) => `"${p.name}"`).join(', ') || 'none'

/** `profile_not_found` (a refusal, outcome `denied`) with the names that exist in `next`: the model retries with a real one or creates it. */
export function unknownProfile(ref: string, list: readonly BrowserProfile[], creatable: boolean): ToolResult {
  const make = creatable ? ` or create it with browser_profile {"action":"create","name":"${ref.slice(0, 40)}"}` : ''
  return { ok: false, code: 'profile_not_found', data: { profiles: list.map((p) => p.name), next: `No browser profile "${ref.slice(0, 40)}". Available: ${quoted(list)}. Call again with one of these names${make}.` } }
}

const KEYS = ['projectId', 'action', 'name', 'color']
const ACTIONS = ['list', 'create'] as const
const shapeOk = (input: ToolInput): boolean => Object.keys(input).every((k) => KEYS.includes(k))
  && (input.action === 'list' ? input.name === undefined && input.color === undefined : input.action === 'create' && typeof input.name === 'string')
  && (input.color === undefined || typeof input.color === 'string')

/** Builds `browser_profile`; only registered when the profile port exists. */
export function createBrowserProfileDef(port: BrowserProfilePort): ToolDef {
  return {
    name: 'browser_profile',
    summary: 'List the browser profiles (separate logins) or create one. Cookies stay with the human.',
    tier: 'R1',
    enabled: agentControlOn,
    usage: `{"projectId":"<id>","action":"list"} | {"projectId":"<id>","action":"create","name":"<1-40 chars, unique>","color":"<optional: ${WORKSPACE_HUES.join('|')}>"}. A profile is a separate set of logins and cookies; use one with browser_open {"profile":"<name>"}. A new profile starts empty (the human signs in) and gets a color of its own when you give none. You cannot read, import, export or delete cookies or profiles.`,
    input: obj({ action: S.oneOf(...ACTIONS), name: S.str(40), color: S.str(16) }, ['action']),
    output: S.keys('profiles', 'profile'),
    auditKeys: ['action'],
    validate: (input) => (shapeOk(input) ? null : 'invalid_shape'),
    handler(ctx, input, projectId): ToolResult {
      const found = browserNodesOf(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      if (input.action === 'list') return { ok: true, data: { profiles: port.list(found.workspaceId).map(profileView) } }
      const made = port.create({ name: input.name as string, ...(typeof input.color === 'string' ? { color: input.color } : {}) })
      if (!made.ok) return { ok: false, code: made.code, ...(made.code === 'profile_name_taken' ? { data: { next: `A profile with that name exists. Available: ${quoted(port.list(found.workspaceId))}. Use it with browser_open.` } } : {}) }
      return { ok: true, data: { profile: profileView(made.profile) } }
    },
  }
}
