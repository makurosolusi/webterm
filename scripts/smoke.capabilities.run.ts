// Drivers of the capability smoke: send ONE prompt to a real model through the same HTTP surface the UI uses
// (Central chat API / Agent Chat node) and collect the tool evidence. No grading here (smoke.capabilities.judge.ts).
import { randomUUID } from 'node:crypto'
import { centralEvidence, chatEvidence, isNetworkFailure } from './smoke.capabilities.evidence'
import type { Evidence } from './smoke.capabilities.judge'
import type { SmokeServer } from './smoke.capabilities.server'

export const CASE_TIMEOUT_MS = 300_000
const POLL_MS = 1_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface RunResult {
  evidence: Evidence
  model: string
  costUsd: number | null
  /** Set when the run itself broke (not a behavior verdict). `network` = worth one retry. */
  failure?: { detail: string; network: boolean }
}

const jsonHeaders = (s: SmokeServer): Record<string, string> => ({ 'content-type': 'application/json', 'x-webterm-token': s.token, cookie: s.cookie })

async function api<T>(s: SmokeServer, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${s.base}${path}`, { method, headers: jsonHeaders(s), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : undefined) as T
}

/** Central chat: a new conversation (optionally mode-locked), one message, wait for the reply to settle. */
export async function runCentral(s: SmokeServer, opts: { mode?: 'skill-author'; prompt: string }): Promise<RunResult> {
  const conv = await api<{ id: string }>(s, 'POST', '/api/central/conversations', opts.mode ? { mode: opts.mode } : {})
  const path = `/api/central/conversations/${encodeURIComponent(conv.id)}`
  await api(s, 'POST', `${path}/messages`, { clientMessageId: randomUUID(), text: opts.prompt })
  const deadline = Date.now() + CASE_TIMEOUT_MS
  let items: Array<Record<string, unknown>> = []
  for (;;) {
    items = (await api<{ items: Array<Record<string, unknown>> }>(s, 'GET', `${path}/messages?limit=200`)).items
    const last = items[items.length - 1]
    if (last?.role === 'assistant' && last.state !== 'streaming') break
    if (Date.now() > deadline) return { evidence: centralEvidence(items), model: '?', costUsd: null, failure: { detail: `timeout after ${CASE_TIMEOUT_MS} ms`, network: false } }
    await sleep(POLL_MS)
  }
  const model = await api<Record<string, unknown>>(s, 'GET', `${path}/model`).catch((): Record<string, unknown> => ({}))
  const reply = items[items.length - 1] ?? {}
  const errPart = (Array.isArray(reply.parts) ? reply.parts : []).find((p: { type?: string }) => p.type === 'error') as { code?: string; message?: string } | undefined
  const usage = reply.usage as { costMicros?: number; model?: string } | undefined
  const detail = errPart ? `${errPart.code ?? ''} ${errPart.message ?? ''}`.trim() : ''
  return {
    evidence: centralEvidence(items),
    model: usage?.model ?? String(model.model ?? model.effectiveModel ?? 'default'),
    costUsd: typeof usage?.costMicros === 'number' ? usage.costMicros / 1e6 : null, // client-side estimate, not a bill
    ...(errPart ? { failure: { detail, network: isNetworkFailure(detail) } } : {}),
  }
}

/** Pending skill drafts in the store (what the Skills panel would show for review). */
export async function countDrafts(s: SmokeServer): Promise<number> {
  const body = await api<{ items?: Array<{ record?: { status?: string } }> } | Array<{ record?: { status?: string } }>>(s, 'GET', '/api/central/skills')
  const rows = Array.isArray(body) ? body : (body.items ?? [])
  return rows.filter((r) => r.record?.status === 'pending_approval').length
}

const NODE_BASE = { x: 0, y: 0, agentId: 'claude', title: 'Agent Chat' } as const
let workspaceId: string | undefined

/** One board for the whole run (chat nodes live on a board). The ledger project is NOT pre-synced: Central's web read must create it itself. */
export async function seedBoard(s: SmokeServer): Promise<void> {
  const created = await api<{ id: string }>(s, 'POST', '/api/workspaces', { name: 'capability-smoke', cwd: s.cwd })
  workspaceId = created.id
}

/** Adds one Agent Chat node to the seeded board and returns its id. */
async function addChatNode(s: SmokeServer, preset: string | undefined): Promise<string> {
  if (!workspaceId) throw new Error('seedBoard must run before the first chat case')
  const id = `chat-${randomUUID()}`
  const node = { id, kind: 'agentChat', cwd: s.cwd, ...NODE_BASE, ...(preset ? { preset } : {}) }
  const ws = await api<{ nodes: unknown[] }>(s, 'GET', `/api/workspaces/${workspaceId}`)
  await api(s, 'PUT', `/api/workspaces/${workspaceId}`, { ...ws, nodes: [...ws.nodes, node] })
  return id
}

/** SSE of one chat node: every event so far, plus a stop function. */
async function openStream(s: SmokeServer, nodeId: string, onEvent: (e: Record<string, unknown>) => void): Promise<() => void> {
  const ctl = new AbortController()
  const r = await fetch(`${s.base}/api/agent-chat/${nodeId}/stream?after=0`, { headers: jsonHeaders(s), signal: ctl.signal })
  if (r.status !== 200 || !r.body) throw new Error(`chat stream -> HTTP ${r.status}`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  void (async () => {
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value)
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const data = f.split('\n').find((l) => l.startsWith('data: '))
        if (data) onEvent(JSON.parse(data.slice(6)) as Record<string, unknown>)
      }
    }
  })().catch((err: unknown) => { if (!ctl.signal.aborted) throw err })
  return () => ctl.abort()
}

/** Agent Chat node (optionally with the skill-author preset): one message, wait for the turn's `result`. */
export async function runChat(s: SmokeServer, opts: { preset?: 'skill-author'; prompt: string }): Promise<RunResult> {
  const nodeId = await addChatNode(s, opts.preset)
  const events: Array<Record<string, unknown>> = []
  const answered = new Set<string>()
  const stop = await openStream(s, nodeId, (e) => {
    events.push(e)
    // A default chat asks before Bash: allow only the browser CLI the smoke is about, deny anything else.
    if (e.t === 'permission' && typeof e.requestId === 'string' && !answered.has(e.requestId)) {
      answered.add(e.requestId)
      const cmd = String((e.input as { command?: unknown } | null)?.command ?? '')
      const allow = e.toolName === 'Bash' && /^webterm (browser (open|navigate|snapshot)|skills (list|propose|get))\b/.test(cmd)
      const body = allow ? { requestId: e.requestId, behavior: 'allow' } : { requestId: e.requestId, behavior: 'deny', message: 'smoke: not part of the browser capability' }
      void api(s, 'POST', `/api/agent-chat/${nodeId}/permission`, body).catch(() => undefined) // 409 = already settled
    }
  })
  try {
    await api(s, 'POST', `/api/agent-chat/${nodeId}/send`, { text: opts.prompt })
    const deadline = Date.now() + CASE_TIMEOUT_MS
    while (!events.some((e) => e.t === 'result')) {
      if (Date.now() > deadline) return { evidence: chatEvidence(events), model: modelOf(events), costUsd: null, failure: { detail: `timeout after ${CASE_TIMEOUT_MS} ms`, network: false } }
      await sleep(200)
    }
    await sleep(300) // trailing tool/message events of the same turn
    const result = events.find((e) => e.t === 'result') as { costUsd?: number; isError?: boolean } | undefined
    const errors = events.filter((e) => e.t === 'notice' && e.level === 'error').map((e) => String(e.text))
    const detail = result?.isError || errors.length > 0 ? errors.join(' | ') || 'turn ended with isError' : ''
    return {
      evidence: chatEvidence(events), model: modelOf(events), costUsd: result?.costUsd ?? null,
      ...(detail ? { failure: { detail, network: isNetworkFailure(detail) } } : {}),
    }
  } finally {
    stop()
  }
}

const modelOf = (events: Array<Record<string, unknown>>): string => String(events.find((e) => e.t === 'init')?.model ?? '?')
