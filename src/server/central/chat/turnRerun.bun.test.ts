// Bun-only (bun:sqlite + every ledger migration). Regenerate / Edit of the last human message through the
// HTTP route: same text re-run, edited text re-run, superseded rows hidden from the thread but kept, a
// fresh session for the re-run, 409 while a turn runs, 400/404 for any other message. Mock runtime only.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openLedgerDb } from '../../ledger/migration'
import { allRows } from '../../ledger/ledgerCore'
import { centralChatRoute, type CentralChatDeps } from '../../centralChatApi'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import { listConversationEvents } from '../conversationStore'
import type { CentralRuntime, TurnInput } from '../runtime/centralRuntime'
import { MockRuntime } from '../runtime/mockRuntime'
import { insertCheckpoint, latestCheckpoint } from '../context/checkpointStore'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

const dir = mkdtempSync(join(tmpdir(), 'central-rerun-'))
const saved = { data: process.env['WEBTERM_DATA_DIR'], home: process.env['HOME'], claude: process.env['CLAUDE_CONFIG_DIR'] }
process.env['WEBTERM_DATA_DIR'] = join(dir, 'data')
process.env['HOME'] = dir
process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'claude')
afterAll(() => {
  for (const [key, value] of [['WEBTERM_DATA_DIR', saved.data], ['HOME', saved.home], ['CLAUDE_CONFIG_DIR', saved.claude]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

const CONV = 'central:global'
const BASE = `/api/central/conversations/${encodeURIComponent(CONV)}`

function setup(stepDelayMs = 1) {
  const db = openLedgerDb(':memory:')
  const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
  const inner = new MockRuntime({ stepDelayMs })
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'mock',
    turn: (input, emit, signal) => { inputs.push(input); return inner.turn(input, emit, signal) },
    cancel: (id, reason) => inner.cancel(id, reason),
  }
  const service = new TurnService({ db, stream, runtime })
  const ledger = { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  const deps: CentralChatDeps = { ledger, chatEnabled: true, centralEnabled: true, runtimeKind: 'mock', service, stream }
  return { db, service, deps, inputs }
}

async function call(deps: CentralChatDeps, path: string, method = 'GET', body?: unknown) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as IncomingMessage
  req.method = method
  req.headers = {}
  let payload = ''
  const res = {
    statusCode: 200, writableEnded: false, setHeader() {}, write(c: string) { payload += c },
    end(c = '') { payload += c; this.writableEnded = true }, on() { return this }, flushHeaders() {},
  }
  await centralChatRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), deps)
  return { status: res.statusCode, json: (payload === '' ? {} : JSON.parse(payload)) as Record<string, unknown> }
}

type Msg = { id: string; role: string; state: string; turnId: string | null; parts: Array<{ type: string; text?: string }> }
const thread = async (deps: CentralChatDeps) => (await call(deps, `${BASE}/messages`)).json['items'] as Msg[]
const textOf = (m: Msg | undefined) => (m?.parts ?? []).map((p) => p.text ?? '').join('')

/** Sends `text` and waits for its turn to finish. */
async function exchange(s: ReturnType<typeof setup>, cid: string, text: string) {
  const sent = await call(s.deps, `${BASE}/messages`, 'POST', { clientMessageId: cid, text })
  expect(sent.status).toBe(202)
  await s.service.waitFor(String(sent.json['turnId']))
  return sent.json
}

async function rerun(s: ReturnType<typeof setup>, mode: 'regenerate' | 'edit', body: Record<string, unknown>) {
  const res = await call(s.deps, `${BASE}/${mode}`, 'POST', body)
  if (res.status === 202) await s.service.waitFor(String(res.json['turnId']))
  return res
}

describe('regenerate', () => {
  it('re-runs the same text in a fresh session and supersedes the old exchange, kept for audit', async () => {
    const s = setup()
    await exchange(s, 'c1', 'first')
    await exchange(s, 'c2', 'what is up')
    const before = await thread(s.deps)
    const [oldHuman, oldReply] = before.slice(-2)
    expect(s.inputs.at(-1)?.sessionRef).toBe(`mock:${CONV}`)

    const res = await rerun(s, 'regenerate', { clientMessageId: 'r1', messageId: oldReply!.id })
    expect(res.status).toBe(202)
    // The runtime got the same human text, without resuming the session that holds the old reply.
    expect(s.inputs.at(-1)?.text).toBe('what is up')
    expect(s.inputs.at(-1)?.sessionRef).toBe(undefined)

    const after = await thread(s.deps)
    expect(after.map((m) => m.id)).not.toContain(oldHuman!.id)
    expect(after.map((m) => m.id)).not.toContain(oldReply!.id)
    expect(after).toHaveLength(4)
    expect(textOf(after[2])).toBe('what is up')
    expect(after[3]!.state).toBe('complete')

    const kept = allRows(s.db, `SELECT id FROM central_message WHERE state = 'superseded' ORDER BY seq`).map((r) => r['id'])
    expect(kept).toEqual([oldHuman!.id, oldReply!.id])
    const audit = listConversationEvents(s.db, CONV, 0, 500).filter((e) => e.type === 'message.superseded')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.payload).toEqual({ messageIds: [oldHuman!.id, oldReply!.id], reason: 'regenerate' })

    // Once the re-run succeeded, the next turn resumes normally again.
    await exchange(s, 'c3', 'next')
    expect(s.inputs.at(-1)?.sessionRef).toBe(`mock:${CONV}`)
  })

  it('a repeated clientMessageId replays the same turn instead of superseding twice', async () => {
    const s = setup()
    await exchange(s, 'c1', 'hi')
    const [human] = await thread(s.deps)
    const a = await rerun(s, 'regenerate', { clientMessageId: 'r1', messageId: human!.id })
    const b = await rerun(s, 'regenerate', { clientMessageId: 'r1', messageId: human!.id })
    expect(b.status).toBe(202)
    expect(b.json['turnId']).toBe(a.json['turnId'])
    expect(s.inputs).toHaveLength(2)
  })

  it('drops checkpoints that summarised the superseded exchange', async () => {
    const s = setup()
    await exchange(s, 'c1', 'hi')
    const [, reply] = await thread(s.deps)
    insertCheckpoint(s.db, { conversationId: CONV, fromMessageId: null, toMessageId: reply!.id, factsJson: '{}', narrative: 'assistant: old reply', source: 'fallback', now: 1 })
    await rerun(s, 'regenerate', { clientMessageId: 'r1', messageId: reply!.id })
    expect(latestCheckpoint(s.db, CONV)?.narrative ?? '').not.toContain('old reply')
  })
})

describe('edit', () => {
  it('replaces the text of the last message and re-runs it', async () => {
    const s = setup()
    await exchange(s, 'c1', 'typo questoin')
    const [human] = await thread(s.deps)
    const res = await rerun(s, 'edit', { clientMessageId: 'e1', messageId: human!.id, text: 'fixed question' })
    expect(res.status).toBe(202)
    expect(s.inputs.at(-1)?.text).toBe('fixed question')
    const after = await thread(s.deps)
    expect(after.map((m) => m.role)).toEqual(['human', 'assistant'])
    expect(textOf(after[0])).toBe('fixed question')
    expect(textOf(after[1])).toContain('fixed question')
    // The conversation title follows the edited text, not the superseded one.
    const list = (await call(s.deps, '/api/central/conversations')).json['items'] as Array<{ id: string; title: string }>
    expect(list.find((c) => c.id === CONV)?.title).toBe('fixed question')
  })

  it('refuses an empty edit without superseding anything', async () => {
    const s = setup()
    await exchange(s, 'c1', 'hi')
    const [human] = await thread(s.deps)
    const res = await rerun(s, 'edit', { clientMessageId: 'e1', messageId: human!.id, text: '   ' })
    expect(res.status).toBe(400)
    expect(await thread(s.deps)).toHaveLength(2)
  })
})

describe('refusals', () => {
  it('409 while a turn runs', async () => {
    const s = setup(50)
    await exchange(s, 'c1', 'hi')
    const [human] = await thread(s.deps)
    const running = await call(s.deps, `${BASE}/messages`, 'POST', { clientMessageId: 'c2', text: 'slow' })
    const res = await call(s.deps, `${BASE}/regenerate`, 'POST', { clientMessageId: 'r1', messageId: human!.id })
    expect(res.status).toBe(409)
    expect((res.json['error'] as { code: string }).code).toBe('conversation_busy')
    await s.service.waitFor(String(running.json['turnId']))
  })

  it('400 for a message that is not the last one, 404 for an unknown one', async () => {
    const s = setup()
    await exchange(s, 'c1', 'one')
    await exchange(s, 'c2', 'two')
    const [firstHuman, firstReply, lastHuman] = await thread(s.deps)
    for (const [mode, id] of [['regenerate', firstReply!.id], ['edit', firstHuman!.id]] as const) {
      const res = await rerun(s, mode, { clientMessageId: `x-${mode}`, messageId: id, text: 'new' })
      expect(res.status).toBe(400)
      expect((res.json['error'] as { code: string }).code).toBe('not_last_message')
    }
    const missing = await rerun(s, 'edit', { clientMessageId: 'x3', messageId: 'nope', text: 'new' })
    expect(missing.status).toBe(404)
    // Edit targets the human message only, never the reply.
    const [, , , lastReply] = await thread(s.deps)
    expect((await rerun(s, 'edit', { clientMessageId: 'x4', messageId: lastReply!.id, text: 'new' })).status).toBe(400)
    expect(allRows(s.db, `SELECT 1 FROM central_message WHERE state = 'superseded'`)).toHaveLength(0)
    expect(lastHuman).toBeDefined()
  })
})
