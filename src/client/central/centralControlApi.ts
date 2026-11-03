// Human transport client for the central control panel. Same credential as the rest of the client
// (`x-webterm-token`, via `request`); never a node capability. Paths mirror server handlers:
// CONTROL/HALT exist (guard/haltApi.ts); STATUS, AGENTS, APPROVALS, SKILLS, MEMORY are the
// contract this panel expects and are mounted by WS-19. Malformed rows are dropped, not thrown.
import { useEffect, useState } from 'react'
import { fetchEnv } from '../envSettingsApi'
import { decideApproval } from '../inboxApi'
import { InboxApiError } from '../inboxTypes'
import { request } from '../inboxTransport'
import type {
  AgentActionResult, AgentRow, ApprovalCard, CentralControlClient, ControlView, MemoryRow,
  SkillReviewRow, StatusView,
} from './centralControlTypes'

export const CENTRAL_API = '/api/central'
export const CONTROL_PATH = `${CENTRAL_API}/control`
export const HALT_PATH = `${CENTRAL_API}/halt`
export const STATUS_PATH = `${CENTRAL_API}/status`
export const AGENTS_PATH = `${CENTRAL_API}/agents`
export const APPROVALS_PATH = `${CENTRAL_API}/approvals`
export const SKILLS_PATH = `${CENTRAL_API}/skills`
export const MEMORY_PATH = `${CENTRAL_API}/memory`

/** Rows per page for list endpoints (the server caps lists at 200). */
export const CENTRAL_PAGE_SIZE = 50
const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const CENTRAL_CHAT_KEY = 'WEBTERM_CENTRAL_CHAT'

/** Panel flag from the server env state (`WEBTERM_CENTRAL_CHAT` effective value). Off until loaded and on 401/403/network error (fail-closed); `override` (tests) skips the fetch. */
export function useCentralControlEnabled(override?: boolean): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (override !== undefined) return
    let live = true
    fetchEnv().then(
      (s) => { if (live) setOn(s.entries.some((e) => e.key === CENTRAL_CHAT_KEY && e.effective === 'on')) },
      () => { if (live) setOn(false) },
    )
    return () => { live = false }
  }, [override])
  return override ?? on
}

function rowsOf(body: unknown): unknown[] {
  const items = Array.isArray(body) ? body : isRec(body) ? body.items : undefined
  if (!Array.isArray(items)) throw new InboxApiError('List response malformed', 502, 'bad_response')
  return items
}

function toCard(raw: unknown): ApprovalCard | null {
  if (!isRec(raw) || !str(raw.id) || !str(raw.digest) || !str(raw.nonce) || !str(raw.summary)) return null
  const tier = raw.tier
  if (tier !== 'R0' && tier !== 'R1' && tier !== 'R2' && tier !== 'R3') return null
  const args = Array.isArray(raw.args) ? raw.args.filter(isRec).map((a) => ({ key: str(a.key), value: str(a.value) })) : []
  return {
    id: str(raw.id), tool: str(raw.tool), tier, summary: str(raw.summary), args,
    digest: str(raw.digest), nonce: str(raw.nonce), expiresAt: num(raw.expiresAt), projectId: str(raw.projectId),
    ...(str(raw.confirmPhrase) ? { confirmPhrase: str(raw.confirmPhrase) } : {}),
  }
}

const toAgent = (r: unknown): AgentRow | null => (isRec(r) && str(r.id)
  ? { id: str(r.id), projectId: str(r.projectId), kind: str(r.kind), role: r.role === 'reviewer' ? 'reviewer' : 'worker', runner: r.runner === 'exec' ? 'exec' : 'pty', state: str(r.state) as AgentRow['state'], owner: str(r.owner) as AgentRow['owner'] }
  : null)

const toSkill = (r: unknown): SkillReviewRow | null => (isRec(r) && isRec(r.record) && str(r.record.name)
  ? { record: r.record as unknown as SkillReviewRow['record'], lint: { ok: isRec(r.lint) && r.lint.ok === true, findings: isRec(r.lint) && Array.isArray(r.lint.findings) ? r.lint.findings.map(str) : [] }, diff: str(r.diff) }
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
  }
}

/** Default client over the live server. */
export const centralControlApi: CentralControlClient = {
  async getControl(signal) { return toControl(await request(CONTROL_PATH, { signal })) },
  async getStatus(signal) { return toStatus(await request(STATUS_PATH, { signal })) },
  async halt(reason) { await post(HALT_PATH, { reason }) },
  async listAgents(offset, signal) { return compact(rowsOf(await request(`${AGENTS_PATH}?${page(offset)}`, { signal })).map(toAgent)) },
  async agentAction(id, action, message) {
    const body = await post(`${AGENTS_PATH}/${encodeURIComponent(id)}/${action}`, message === undefined ? {} : { message })
    const approvalId = isRec(body) ? str(body.approvalId) : ''
    return approvalId ? { status: 'needs_approval', approvalId } : ({ status: 'done' } satisfies AgentActionResult)
  },
  async listApprovals(signal) { return compact(rowsOf(await request(`${APPROVALS_PATH}?status=pending`, { signal })).map(toCard)) },
  async decide(card, approve) { await decideApproval({ id: card.id, digest: card.digest, nonce: card.nonce, approve }) },
  async listSkills(signal) { return compact(rowsOf(await request(SKILLS_PATH, { signal })).map(toSkill)) },
  async approveSkill(name, version) { await post(`${SKILLS_PATH}/${encodeURIComponent(name)}/approve`, { version }) },
  async rollbackSkill(name) { await post(`${SKILLS_PATH}/${encodeURIComponent(name)}/rollback`, {}) },
  async listMemory(offset, signal) { return compact(rowsOf(await request(`${MEMORY_PATH}?${page(offset)}`, { signal })).map(toMemory)) },
}
