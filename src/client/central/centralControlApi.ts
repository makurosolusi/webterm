// Human transport client for the central control panel. Same credential as the rest of the client
// (the `wt_ui` session cookie, via `request`); never a node capability. Paths mirror server handlers:
// CONTROL/HALT exist (guard/haltApi.ts); STATUS, AGENTS, SKILLS, MEMORY, TOOLS are the
// contract this panel expects and are mounted by WS-19. Malformed rows are dropped, not thrown.
import { useCapabilities } from '../useCapabilities'
import { InboxApiError } from '../inboxTypes'
import { request } from '../inboxTransport'
import type {
  AgentActionResult, AgentRow, BoardNodeRow, CentralControlClient, ControlView, MemoryRow,
  SkillReviewRow, StatusView, ToolAccess, ToolGroup, ToolRow, ToolsView,
} from './centralControlTypes'

export const CENTRAL_API = '/api/central'
export const CONTROL_PATH = `${CENTRAL_API}/control`
export const HALT_PATH = `${CENTRAL_API}/halt`
export const STATUS_PATH = `${CENTRAL_API}/status`
export const AGENTS_PATH = `${CENTRAL_API}/agents`
export const BOARD_NODES_PATH = `${CENTRAL_API}/nodes`
export const SKILLS_PATH = `${CENTRAL_API}/skills`
export const MEMORY_PATH = `${CENTRAL_API}/memory`
export const TOOLS_PATH = `${CENTRAL_API}/tools`

/** Server codes for a family whose feature is off (503); the tab shows an off state, not an error. */
export const SKILLS_OFF = 'skills_off'
export const AGENTS_OFF = 'agents_off'
/** Sub-option of the Central capability that switches skills (`WEBTERM_CENTRAL_SKILLS`). */
export const CENTRAL_SKILLS_SUB = 'centralSkills'

/** Rows per page for list endpoints (the server caps lists at 200). */
export const CENTRAL_PAGE_SIZE = 50
const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Panel flag from `GET /api/capabilities` (`central` is `on`). Off until loaded and on 401/403/network error (fail-closed); `override` (tests) skips the result. */
export function useCentralControlEnabled(override?: boolean): boolean {
  const { data } = useCapabilities()
  return override ?? data?.capabilities.some((c) => c.id === 'central' && c.status === 'on') === true
}

function rowsOf(body: unknown): unknown[] {
  const items = Array.isArray(body) ? body : isRec(body) ? body.items : undefined
  if (!Array.isArray(items)) throw new InboxApiError('List response malformed', 502, 'bad_response')
  return items
}

const toAgent = (r: unknown): AgentRow | null => (isRec(r) && str(r.id)
  ? { id: str(r.id), projectId: str(r.projectId), kind: str(r.kind), role: r.role === 'reviewer' ? 'reviewer' : 'worker', runner: r.runner === 'exec' ? 'exec' : 'pty', state: str(r.state) as AgentRow['state'], owner: str(r.owner) as AgentRow['owner'], nodeId: str(r.nodeId) || null, startedAt: num(r.startedAt) || null, projectName: str(r.projectName), nodeOnBoard: r.nodeOnBoard === true }
  : null)

const toBoardNode = (r: unknown): BoardNodeRow | null => (isRec(r) && str(r.nodeId) && str(r.workspaceId)
  ? { nodeId: str(r.nodeId), workspaceId: str(r.workspaceId), projectId: str(r.projectId), projectName: str(r.projectName), kind: str(r.kind), title: str(r.title), live: r.live === true, status: str(r.status) || null }
  : null)

const toProject = (r: unknown): { id: string; name: string } | null => (isRec(r) && str(r.id) ? { id: str(r.id), name: str(r.name) } : null)

const toSkill = (r: unknown): SkillReviewRow | null => (isRec(r) && isRec(r.record) && str(r.record.name)
  ? { record: r.record as unknown as SkillReviewRow['record'], lint: { ok: isRec(r.lint) && r.lint.ok === true, findings: isRec(r.lint) && Array.isArray(r.lint.findings) ? r.lint.findings.map(str) : [] }, diff: str(r.diff), canRollback: r.canRollback === true }
  : null)

const toMemory = (r: unknown): MemoryRow | null => (isRec(r) && str(r.id)
  ? { id: str(r.id), scope: str(r.scope) as MemoryRow['scope'], trust: str(r.trust) as MemoryRow['trust'], kind: str(r.kind) as MemoryRow['kind'], key: str(r.key), value: str(r.value) }
  : null)

const compact = <T>(rows: (T | null)[]): T[] => rows.filter((r): r is T => r !== null)
const page = (offset: number) => `limit=${CENTRAL_PAGE_SIZE}&offset=${offset}`
const post = (path: string, body: unknown): Promise<unknown> =>
  request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })

function toControl(b: unknown): ControlView {
  if (!isRec(b) || !isRec(b.global)) throw new InboxApiError('Control response malformed', 502, 'bad_response')
  return {
    ceiling: b.ceiling as ControlView['ceiling'], effective: b.effective as ControlView['effective'],
    global: { level: b.global.level as ControlView['effective'], version: num(b.global.version), reason: str(b.global.reason) || null },
  }
}

function toStatus(b: unknown): StatusView {
  if (!isRec(b) || !isRec(b.used) || !isRec(b.limits) || !isRec(b.model)) throw new InboxApiError('Status response malformed', 502, 'bad_response')
  return {
    budget: { day: str(b.day), used: { tokens: num(b.used.tokens), spawns: num(b.used.spawns) }, limits: { tokens: num(b.limits.tokens), spawns: num(b.limits.spawns) } },
    model: { id: str(b.model.id), free: b.model.free === true },
    lastTurn: isRec(b.lastTurn) ? { at: num(b.lastTurn.at), status: str(b.lastTurn.status) } : null,
  }
}

const GROUPS: readonly ToolGroup[] = ['projects', 'workers', 'tasks', 'memory', 'browser', 'skills', 'channels', 'approvals', 'other']
const ACCESS: readonly ToolAccess[] = ['auto', 'asks', 'blocked', 'off']
const TIERS: readonly ToolRow['tier'][] = ['R0', 'R1', 'R2', 'R3']
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (all.includes(v as T) ? (v as T) : fallback)

const toTool = (r: unknown): ToolRow | null => (isRec(r) && str(r.name)
  ? { name: str(r.name), summary: str(r.summary), group: oneOf(r.group, GROUPS, 'other'), tier: oneOf(r.tier, TIERS, 'R3'), on: r.on !== false, access: oneOf(r.access, ACCESS, 'blocked') }
  : null)

function toTools(b: unknown): ToolsView {
  if (!isRec(b) || !Array.isArray(b.tools)) throw new InboxApiError('Tools response malformed', 502, 'bad_response')
  return { level: b.level as ToolsView['level'], tools: compact(b.tools.map(toTool)) }
}

/** Default client over the live server. */
export const centralControlApi: CentralControlClient = {
  async getControl(signal) { return toControl(await request(CONTROL_PATH, { signal })) },
  async getStatus(signal) { return toStatus(await request(STATUS_PATH, { signal })) },
  async halt(reason) { await post(HALT_PATH, { reason }) },
  async listAgents(offset, signal, filter = {}) {
    const narrow = `${filter.live ? '&live=1' : ''}${filter.projectId ? `&projectId=${encodeURIComponent(filter.projectId)}` : ''}`
    return compact(rowsOf(await request(`${AGENTS_PATH}?${page(offset)}${narrow}`, { signal })).map(toAgent))
  },
  async listBoardNodes(offset, projectId, signal) {
    const body = await request(`${BOARD_NODES_PATH}?${page(offset)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, { signal })
    return { items: compact(rowsOf(body).map(toBoardNode)), projects: isRec(body) && Array.isArray(body.projects) ? compact(body.projects.map(toProject)) : [] }
  },
  async agentAction(id, action, message) {
    const body = await post(`${AGENTS_PATH}/${encodeURIComponent(id)}/${action}`, message === undefined ? {} : { message })
    const approvalId = isRec(body) ? str(body.approvalId) : ''
    return approvalId ? { status: 'needs_approval', approvalId } : ({ status: 'done' } satisfies AgentActionResult)
  },
  async listSkills(signal) { return compact(rowsOf(await request(SKILLS_PATH, { signal })).map(toSkill)) },
  async approveSkill(name, version, phrase) { await post(`${SKILLS_PATH}/${encodeURIComponent(name)}/approve`, { version, phrase }) },
  async rejectSkill(name, version) { await post(`${SKILLS_PATH}/${encodeURIComponent(name)}/reject`, { version }) },
  async rollbackSkill(name) { await post(`${SKILLS_PATH}/${encodeURIComponent(name)}/rollback`, {}) },
  async listMemory(offset, signal) { return compact(rowsOf(await request(`${MEMORY_PATH}?${page(offset)}`, { signal })).map(toMemory)) },
  async listTools(signal) { return toTools(await request(TOOLS_PATH, { signal })) },
  listActiveSkills: (signal) => listActiveSkills(signal),
}

/** Approved skills Central can load (`GET skills?status=active`), for the Central chat `/` list; rejects with `skills_off` when off. */
export async function listActiveSkills(signal?: AbortSignal): Promise<Array<{ name: string; description: string }>> {
  return compact(rowsOf(await request(`${SKILLS_PATH}?status=active`, { signal }))
    .map((r) => (isRec(r) && str(r.name) ? { name: str(r.name), description: str(r.description) } : null)))
}
