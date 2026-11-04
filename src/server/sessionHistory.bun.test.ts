// Bun-only (bun:sqlite). Semua transcript adalah FIXTURE di direktori temp — home pengguna tidak
// pernah disentuh (roots di-inject).
import { afterAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from './db'
import { scanSessions, type ScanRoot } from './sessionHistory.scan'
import { ensureSessionHistorySchema, getIndexed, listSessions } from './sessionHistory.store'
import { CLOSED_HISTORY_PATH, SESSION_HISTORY_PATH, sessionHistoryRoute, type HistoryDeps } from './sessionHistory.route'

const base = mkdtempSync(join(tmpdir(), 'wt-hist-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
function fixture(): { roots: ScanRoot[]; claude: string; codex: string } {
  const dir = join(base, `case${n++}`)
  const claude = join(dir, 'claude-projects')
  const codex = join(dir, 'codex-sessions')
  mkdirSync(claude, { recursive: true })
  mkdirSync(codex, { recursive: true })
  return { roots: [{ agent: 'claude', dir: claude }, { agent: 'codex', dir: codex }], claude, codex }
}

const L = (r: unknown) => `${JSON.stringify(r)}\n`
const user = (text: string, cwd: string, ts: string) => L({ type: 'user', cwd, timestamp: ts, message: { content: text } })
const asst = (ts: string) => L({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'ok' }] } })

function claudeSession(root: string, project: string, id: string, cwd: string, prompt: string, ts = '2026-03-01T10:00:00Z'): string {
  mkdirSync(join(root, project), { recursive: true })
  const p = join(root, project, `${id}.jsonl`)
  writeFileSync(p, user(prompt, cwd, ts) + asst(ts))
  return p
}

const freshDb = (): Database => {
  const d = new Database(':memory:')
  ensureSessionHistorySchema(d)
  return d
}

describe('scan', () => {
  it('indexes claude + codex fixture transcripts with id, title, cwd, times, count', async () => {
    const f = fixture()
    claudeSession(f.claude, '-repo-app', 'c1', '/repo/app', 'first prompt', '2026-03-01T10:00:00Z')
    mkdirSync(join(f.claude, '-repo-app', 'c1', 'subagents'), { recursive: true })
    writeFileSync(join(f.claude, '-repo-app', 'c1', 'subagents', 'agent-x.jsonl'), user('sub', '/repo/app', '2026-03-01T10:00:00Z'))
    mkdirSync(join(f.codex, '2026', '05', '01'), { recursive: true })
    writeFileSync(
      join(f.codex, '2026', '05', '01', 'rollout-2026-05-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'),
      L({ timestamp: '2026-05-01T10:00:00Z', type: 'session_meta', payload: { id: '019f0000-1111-7222-8333-444444444444', cwd: '/repo/app' } }) +
        L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex ask' }] } }),
    )
    const db = freshDb()
    await scanSessions(db, f.roots)
    const page = listSessions(db, {})
    expect(page.total).toBe(2) // subagent transcript is not a resumable session
    expect(page.items[0]).toMatchObject({ agent: 'codex', id: '019f0000-1111-7222-8333-444444444444', title: 'codex ask', cwd: '/repo/app', messageCount: 1 })
    expect(page.items[1]).toMatchObject({
      agent: 'claude', id: 'c1', title: 'first prompt', cwd: '/repo/app', messageCount: 2,
      startedAt: Date.parse('2026-03-01T10:00:00Z'), endedAt: Date.parse('2026-03-01T10:00:00Z'),
    })
  })

  it('is incremental: unchanged files are skipped, appended bytes are parsed from parsed_bytes', async () => {
    const f = fixture()
    const p = claudeSession(f.claude, 'proj', 'c2', '/w', 'original title')
    const db = freshDb()
    await scanSessions(db, f.roots)
    const first = getIndexed(db, p)!
    expect(first.parsedBytes).toBe(first.size)

    // Rewrite the FIRST line in place (same length) and append one turn. A full re-parse would read
    // the new title; an incremental one keeps the stored state and only consumes the appended bytes.
    const fd = openSync(p, 'r+')
    const head = user('original title', '/w', '2026-03-01T10:00:00Z')
    writeSync(fd, head.replace('original title', 'REWRITTEN!!!!!'), 0)
    closeSync(fd)
    appendFileSync(p, asst('2026-03-02T10:00:00Z'))
    await scanSessions(db, f.roots)
    const second = getIndexed(db, p)!
    expect(second.title).toBe('original title')
    expect(second.messageCount).toBe(3)
    expect(second.endedAt).toBe(Date.parse('2026-03-02T10:00:00Z'))

    // A half-written tail line is not consumed until it is complete.
    appendFileSync(p, '{"type":"assistant","timest')
    await scanSessions(db, f.roots)
    expect(getIndexed(db, p)!.parsedBytes).toBe(second.size)
    appendFileSync(p, 'amp":"2026-03-03T10:00:00Z"}\n')
    await scanSessions(db, f.roots)
    expect(getIndexed(db, p)!.messageCount).toBe(4)

    // Shrunk file = rewritten from scratch.
    truncateSync(p, 0)
    writeFileSync(p, user('new start', '/w', '2026-04-01T10:00:00Z'))
    await scanSessions(db, f.roots)
    expect(getIndexed(db, p)).toMatchObject({ title: 'new start', messageCount: 1 })
  })

  it('prunes sessions whose transcript was deleted', async () => {
    const f = fixture()
    const p = claudeSession(f.claude, 'proj', 'gone', '/w', 'bye')
    const db = freshDb()
    await scanSessions(db, f.roots)
    rmSync(p)
    await scanSessions(db, f.roots)
    expect(listSessions(db, {}).total).toBe(0)
  })
})

describe('listSessions', () => {
  it('paginates newest first and filters by workspace cwd including subdirs, not sibling prefixes', async () => {
    const f = fixture()
    for (let i = 0; i < 35; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      claudeSession(f.claude, 'p', `s${i}`, i % 2 ? '/repo/app/sub' : '/repo/app', `prompt ${i}`, ts)
    }
    claudeSession(f.claude, 'q', 'sibling', '/repo/app2', 'other repo')
    const db = freshDb()
    await scanSessions(db, f.roots)

    const p1 = listSessions(db, { cwd: '/repo/app/' })
    expect(p1.total).toBe(35)
    expect(p1.items).toHaveLength(30)
    expect(p1.items[0].id).toBe('s34')
    expect(p1.nextOffset).toBe(30)
    const p2 = listSessions(db, { cwd: '/repo/app', offset: 30 })
    expect(p2.items.map((s) => s.id)).toEqual(['s4', 's3', 's2', 's1', 's0'])
    expect(p2.nextOffset).toBeNull()
    expect(listSessions(db, { limit: 1000 }).items).toHaveLength(36) // capped at PAGE_MAX=100
    expect(listSessions(db, { q: 'prompt 1_' }).total).toBe(0) // LIKE wildcards are escaped
    expect(listSessions(db, { q: 'other' }).items[0].id).toBe('sibling')
  })
})

describe('migration', () => {
  it('is idempotent on a populated webterm.db and keeps existing rows', async () => {
    const file = join(base, 'migr.db')
    const d1 = openDb(file)
    ensureSessionHistorySchema(d1)
    d1.query("INSERT INTO workspace (id, name, updated_at) VALUES ('w1', 'keep', 1)").run()
    d1.query("INSERT INTO closed_history (node_id, workspace_id, workspace_name, closed_at, node) VALUES ('n1', 'w1', 'keep', 5, '{\"id\":\"n1\",\"kind\":\"agent\",\"x\":0,\"y\":0}')").run()
    ensureSessionHistorySchema(d1)
    const d2 = openDb(file)
    ensureSessionHistorySchema(d2)
    expect((d2.query('SELECT COUNT(*) AS n FROM closed_history').get() as { n: number }).n).toBe(1)
    expect((d2.query("SELECT name FROM workspace WHERE id = 'w1'").get() as { name: string }).name).toBe('keep')
  })
})

describe('route', () => {
  const noBody = async () => ''
  const deps = (db: Database, roots: ScanRoot[], now = () => 0): HistoryDeps => ({ db, roots, now })

  it('closed history survives a restart (new connection on the same file)', async () => {
    const file = join(base, 'closed.db')
    const d1 = openDb(file)
    ensureSessionHistorySchema(d1)
    const entries = [
      { node: { id: 'a1', kind: 'agent', x: 1, y: 2, agentId: 'claude', sessionId: 'sid-1' }, workspaceId: 'w1', workspaceName: 'proj', closedAt: 20 },
      { node: { id: 't1', kind: 'terminal', x: 0, y: 0 }, workspaceId: 'w1', workspaceName: 'proj', closedAt: 10 },
    ]
    const put = await sessionHistoryRoute(CLOSED_HISTORY_PATH, 'PUT', new URLSearchParams(), async () => JSON.stringify({ entries }), deps(d1, []))
    expect(put?.status).toBe(204)

    const d2 = openDb(file)
    ensureSessionHistorySchema(d2)
    const got = await sessionHistoryRoute(CLOSED_HISTORY_PATH, 'GET', new URLSearchParams(), noBody, deps(d2, []))
    expect(got?.body).toEqual({ entries })

    const empty = await sessionHistoryRoute(CLOSED_HISTORY_PATH, 'PUT', new URLSearchParams(), async () => '{"entries":[]}', deps(d2, []))
    expect(empty?.status).toBe(204)
    expect((await sessionHistoryRoute(CLOSED_HISTORY_PATH, 'GET', new URLSearchParams(), noBody, deps(d2, [])))?.body).toEqual({ entries: [] })
  })

  it('rejects malformed closed-history bodies with 400', async () => {
    const db = freshDb()
    for (const raw of ['nope', '[]', '{"entries":[{"node":{}}]}', JSON.stringify({ entries: Array(11).fill({ node: { id: 'x', kind: 'agent' }, workspaceId: 'w', workspaceName: 'n', closedAt: 1 }) })]) {
      const r = await sessionHistoryRoute(CLOSED_HISTORY_PATH, 'PUT', new URLSearchParams(), async () => raw, deps(db, []))
      expect(r?.status).toBe(400)
    }
  })

  it('GET session-history scans, pages, throttles rescans, and refresh=1 forces one', async () => {
    const f = fixture()
    claudeSession(f.claude, 'p', 'r1', '/w', 'one')
    const db = freshDb()
    let now = 100_000
    const d = deps(db, f.roots, () => now)
    const get = async (qs: string) => (await sessionHistoryRoute(SESSION_HISTORY_PATH, 'GET', new URLSearchParams(qs), noBody, d))?.body as { total: number; items: { id: string }[]; nextOffset: number | null }

    expect((await get('cwd=/w&limit=1')).total).toBe(1)
    claudeSession(f.claude, 'p', 'r2', '/w', 'two')
    now += 1000
    expect((await get('cwd=/w')).total).toBe(1) // inside the throttle window
    expect((await get('cwd=/w&refresh=1')).total).toBe(2)
    const page = await get('cwd=/w&limit=1&offset=1')
    expect(page.items).toHaveLength(1)
    expect(page.nextOffset).toBeNull()
    expect(await sessionHistoryRoute('/api/other', 'GET', new URLSearchParams(), noBody, d)).toBeNull()
  })
})
