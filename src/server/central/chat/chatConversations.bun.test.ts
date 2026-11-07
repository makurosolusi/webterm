// Bun-only (needs bun:sqlite). Multiple Central chats: create, list (paged, newest first),
// send to a non-default chat, `central:global` back-compat, id validation, and a fresh Claude
// session per conversation through the fake `claude` executable (never the real CLI).
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import { openLedgerDb } from '../../ledger/migration'
import { centralChatRoute, type CentralChatDeps } from '../../centralChatApi'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import { listConversationEvents } from '../conversationStore'
import { MockRuntime } from '../runtime/mockRuntime'
import { ClaudeRuntime } from '../runtime/claudeRuntime'
import { createCentralMcpLink } from '../runtime/claudeMcp'
import { initRecord, resultRecord, writeFakeClaude } from '../runtime/claude.fakeBin'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'
import { createChatConversation, listConversationSummaries } from './turnPersistence'

const dir = mkdtempSync(join(tmpdir(), 'central-chats-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(runtime: 'mock' | ClaudeRuntime = 'mock') {
  const db = openLedgerDb(':memory:')
  const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
  const service = new TurnService({
    db, stream, runtime: runtime === 'mock' ? new MockRuntime({ chunks: ['ok'], stepDelayMs: 1 }) : runtime,
  })
  const ledger = { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  const deps: CentralChatDeps = { ledger, chatEnabled: true, centralEnabled: true, runtimeKind: 'mock', service, stream }
  return { db, service, deps }
}

async function call(deps: CentralChatDeps, path: string, method = 'GET', body?: string) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
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

const send = (deps: CentralChatDeps, id: string, clientMessageId: string, text = 'hello') =>
  call(deps, `/api/central/conversations/${encodeURIComponent(id)}/messages`, 'POST', JSON.stringify({ clientMessageId, text }))

type Row = { id: string; title: string | null; turnCount: number; updatedAt: number }
const rows = (json: Record<string, unknown>) => json['items'] as Row[]

describe('create and list', () => {
  it('POST creates an empty chat that lists first; GET pages newest first', async () => {
    const { deps } = setup()
    const created = await call(deps, '/api/central/conversations', 'POST', '{}')
    expect(created.status).toBe(201)
    const id = String(created.json['id'])
    expect(id).toMatch(/^central:chat:[0-9a-f-]{36}$/)
    expect(created.json['title']).toBe(null)
    expect(created.json['turnCount']).toBe(0)

    const listed = await call(deps, '/api/central/conversations')
    expect(listed.status).toBe(200)
    expect(rows(listed.json).map((r) => r.id)).toContain('central:global')
    expect(listed.json['nextOffset']).toBe(null)
  })

  it('paginates with limit/offset and rejects bad params', async () => {
    const { db, deps } = setup()
    for (let i = 1; i <= 5; i += 1) createChatConversation(db, 1_000 + i)
    const first = listConversationSummaries(db, { limit: 2, now: 1 })
    expect(first.items).toHaveLength(2)
    expect(first.items[0]!.updatedAt).toBe(1_005)
    expect(first.nextOffset).toBe(2)
    const last = listConversationSummaries(db, { limit: 2, offset: 4 })
    // 5 chats + the default global one.
    expect(last.items).toHaveLength(2)
    expect(last.nextOffset).toBe(null)
    expect((await call(deps, '/api/central/conversations?limit=0')).status).toBe(400)
    expect((await call(deps, '/api/central/conversations?limit=201')).status).toBe(400)
    expect((await call(deps, '/api/central/conversations?offset=-1')).status).toBe(400)
  })
})

describe('sending', () => {
  it('sends to a non-default chat; title and turn count follow; global stays separate', async () => {
    const { deps, service } = setup()
    const id = String((await call(deps, '/api/central/conversations', 'POST')).json['id'])
    const sent = await send(deps, id, 'c1', `Plan the release ${'x'.repeat(100)}`)
    expect(sent.status).toBe(202)
    await service.waitFor(String(sent.json['turnId']))

    const history = await call(deps, `/api/central/conversations/${encodeURIComponent(id)}/messages`)
    expect((history.json['items'] as unknown[]).length).toBe(2)
    const chat = rows((await call(deps, '/api/central/conversations')).json).find((r) => r.id === id)!
    const globalHistory = await call(deps, '/api/central/conversations/central%3Aglobal/messages')
    expect((globalHistory.json['items'] as unknown[]).length).toBe(0)
    expect(chat.title!.startsWith('Plan the release x')).toBe(true)
    expect(chat.title!.length).toBe(80)
    expect(chat.turnCount).toBe(1)
  })

  it('keeps central:global as the default conversation (back-compat)', async () => {
    const { deps, service, db } = setup()
    const sent = await send(deps, 'central:global', 'g1')
    expect(sent.status).toBe(202)
    await service.waitFor(String(sent.json['turnId']))
    expect(rows((await call(deps, '/api/central/conversations')).json)[0]!.id).toBe('central:global')
    expect(listConversationSummaries(db).items[0]!.turnCount).toBe(1)
  })

  it('rejects malformed and unknown chat ids at the boundary', async () => {
    const { deps } = setup()
    const bad = await send(deps, 'central:chat:../etc', 'x')
    expect(bad.status).toBe(400)
    expect((bad.json['error'] as { code: string }).code).toBe('invalid_conversation')
    const unknown = await send(deps, 'central:chat:abc-123', 'x')
    expect(unknown.status).toBe(404)
    expect((unknown.json['error'] as { code: string }).code).toBe('conversation_not_found')
    expect((await call(deps, '/api/central/conversations/central%3Achat%3Aabc-123/messages')).status).toBe(404)
    expect((await call(deps, '/api/central/conversations/central%3Achat%3Aabc-123/stream')).status).toBe(404)
  })
})

describe('Claude session per conversation', () => {
  it('a new chat starts a fresh session instead of resuming the previous one', async () => {
    // One fake CLI for every turn: logs its argv, answers with session `sess-<n>` for the n-th run.
    const log = join(dir, 'argv.jsonl')
    const executable = writeFakeClaude(dir, `const prev = fs.existsSync(${JSON.stringify(log)})
  ? fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(Boolean).length : 0
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
readStdin()
const session = 'sess-' + (prev + 1)
emit({ ...${JSON.stringify(initRecord())}, session_id: session })
emit({ ...${JSON.stringify(resultRecord())}, session_id: session })`)
    let fresh = 0
    const runtime = new ClaudeRuntime({
      executable,
      workDir: join(dir, 'work'),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir },
      killGraceMs: 50,
      newSessionId: () => `new-${++fresh}`,
      // test-only token: keeps the process capability store out of this test
      mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
    })
    const { db, deps, service } = setup(runtime)
    const turn = async (id: string, cid: string): Promise<void> => {
      const sent = await send(deps, id, cid)
      expect(sent.status).toBe(202)
      await service.waitFor(String(sent.json['turnId']))
    }
    await turn('central:global', 'g1')
    await turn('central:global', 'g2')
    const chat = createChatConversation(db).id
    await turn(chat, 'c1')
    await turn(chat, 'c2')

    const argvs = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
    expect(argvs).toHaveLength(4)
    expect(argvs[0]).not.toContain('--resume')
    expect(argvs[1]![argvs[1]!.indexOf('--resume') + 1]).toBe('sess-1')
    expect(argvs[2]).not.toContain('--resume')
    expect(argvs[2]).toContain('--session-id')
    expect(argvs[3]![argvs[3]!.indexOf('--resume') + 1]).toBe('sess-3')
  }, 20_000)
})
