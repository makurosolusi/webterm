// Replay read-model over a real in-memory ledger (migrated), real event log rows, real cost rows, a
// fake Claude JSONL transcript, and a REAL temp git repo for the checkpoint diff (never the user's).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { createCheckpoint, repoOf } from '../checkpoint/checkpoint.git'
import { insertCostUsage } from '../cost/costStore'
import { createEventLog } from '../events/eventLog'
import { migrate } from '../ledger/migration'
import { checkpointAt, checkpointBefore } from './replay.checkpoint'
import { stateAt, type ReplayItem } from './replay.model'
import { replayRoute, type ReplayDeps } from './replay.route'

let db: Database
let deps: ReplayDeps
const T0 = 1_700_000_000_000 // test-only fixed clock
const WS = { id: 'ws-1', cwd: undefined as string | undefined, nodes: [{ id: 'n1' }, { id: 'n2' }] as never[] }

const jsonl = (ts: number, type: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type, timestamp: new Date(ts).toISOString(), message: { content: [{ type: 'text', text }] } })

function cost(key: string, ts: number, nodeId: string, micros: number) {
  insertCostUsage(db, { key, ts, source: 'agent', workspaceId: 'ws-1', nodeId, sessionId: null, model: 'claude-test', input: 10, output: 5, cacheRead: 0, write5m: 0, write1h: 0, costMicros: micros })
}

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  const log = createEventLog(db)
  const ev = (ts: number, kind: string, nodeId: string | null, payload: unknown, workspaceId: string | null = null) =>
    log.append({ kind, source: 'test', trust: 'trusted', ts, nodeId, workspaceId, payload })
  ev(T0 + 100, 'hook.UserPromptSubmit', 'n1', { preview: 'fix the bug' })
  ev(T0 + 300, 'hook.PreToolUse', 'n1', { toolName: 'Edit' })
  ev(T0 + 300, 'policy.decision', 'n1', { effect: 'allow', capability: 'fs.write' }) // allows are not shown
  ev(T0 + 400, 'permission.decision', 'n1', { behavior: 'deny', label: 'rm -rf build', tool: 'Bash' })
  ev(T0 + 500, 'mcp.call', 'n1', { tool: 'browser.act', outcome: 'ok', detail: 'ok' })
  ev(T0 + 600, 'checkpoint.created', null, { seq: 1, reason: 'prompt' }, 'ws-1')
  ev(T0 + 700, 'hook.PostToolUse', 'n2', { toolName: 'Read' })
  ev(T0 + 800, 'edge.change', 'n1', {}) // not a replay lane
  ev(T0 + 900, 'hook.Stop', 'n1', {})
  ev(T0 + 50, 'hook.Stop', 'other-node', {}, 'ws-2') // other workspace
  cost('c1', T0 + 300, 'n1', 1500)
  cost('c2', T0 + 950, 'n1', 2500)
  const transcripts: Record<string, string> = {
    n1: [jsonl(T0 + 100, 'user', 'fix the bug'), '{"type":"summary"}', jsonl(T0 + 300, 'assistant', 'Editing a.ts'), jsonl(T0 + 850, 'assistant', 'Done.'), '{"partial'].join('\n'),
  }
  deps = {
    db,
    workspace: (id) => (id === 'ws-1' ? WS : null),
    transcript: (id) => transcripts[id] ?? null,
    scrollback: (id) => (id === 'n1' ? '$ npm test\nok' : null),
    checkpointAt: async (_ws, _cwd, t) => (t >= T0 + 600 ? { seq: 1, ts: T0 + 600, reason: 'prompt', baseSeq: null, files: [], patch: '', truncated: false } : null),
  }
})

async function page(query: string): Promise<{ items: ReplayItem[]; nextCursor: string | null }> {
  const res = await replayRoute('/api/replay', 'GET', new URLSearchParams(query), async () => deps)
  expect(res?.status).toBe(200)
  return res!.body as { items: ReplayItem[]; nextCursor: string | null }
}

test('correlation: events, transcript turns and cost merge into one ts-ordered list with lanes', async () => {
  const { items, nextCursor } = await page('workspace=ws-1')
  expect(nextCursor).toBeNull()
  expect(items.map((i) => [i.ts - T0, i.lane, i.source])).toEqual([
    [100, 'transcript', 'event'], [100, 'transcript', 'transcript'],
    [300, 'tool', 'event'], [300, 'transcript', 'transcript'], [300, 'cost', 'cost'],
    [400, 'approval', 'event'], [500, 'browser', 'event'], [600, 'file', 'event'], [700, 'tool', 'event'],
    [850, 'transcript', 'transcript'], [900, 'transcript', 'event'], [950, 'cost', 'cost'],
  ])
  expect(items.find((i) => i.lane === 'file')?.checkpointSeq).toBe(1)
  expect(items.find((i) => i.lane === 'approval')?.text).toBe('Approval deny: rm -rf build')
})

test('node scope keeps only that node; range filter is [from, to)', async () => {
  const n2 = await page('workspace=ws-1&node=n2')
  expect(n2.items.map((i) => i.text)).toEqual(['Tool done: Read'])
  const ranged = await page(`workspace=ws-1&from=${T0 + 300}&to=${T0 + 600}`)
  expect(ranged.items.map((i) => i.ts - T0)).toEqual([300, 300, 300, 400, 500])
})

test('pagination: keyset pages are disjoint, ordered, and add up to the full list', async () => {
  const full = (await page('workspace=ws-1')).items.map((i) => i.key)
  const seen: string[] = []
  let cursor = ''
  for (let n = 0; n < 10; n++) {
    const p = await page(`workspace=ws-1&limit=5${cursor ? `&cursor=${cursor}` : ''}`)
    expect(p.items.length <= 5).toBe(true)
    seen.push(...p.items.map((i) => i.key))
    if (!p.nextCursor) break
    cursor = p.nextCursor
  }
  expect(seen).toEqual(full)
  const bad = await replayRoute('/api/replay', 'GET', new URLSearchParams('workspace=ws-1&cursor=nope'), async () => deps)
  expect(bad?.status).toBe(400)
})

test('scrub state at t: pure fold over items, and the server state (transcript, checkpoint, cost)', async () => {
  const { items } = await page('workspace=ws-1')
  const s = stateAt(items, T0 + 650)
  expect(s.current?.lane).toBe('file')
  expect(s.checkpoint).toEqual({ seq: 1, ts: T0 + 600 })
  expect(s.costMicros).toBe(1500)
  expect(s.counts).toMatchObject({ transcript: 3, tool: 1, approval: 1, browser: 1, file: 1, cost: 1 })
  expect(stateAt(items, T0).current).toBeNull()

  const res = await replayRoute('/api/replay/state', 'GET', new URLSearchParams(`workspace=ws-1&node=n1&t=${T0 + 650}`), async () => deps)
  const body = res!.body as { transcript: { text: string }[]; checkpoint: { seq: number } | null; costMicros: number; scrollback: unknown }
  expect(body.transcript.map((l) => l.text)).toEqual(['user: fix the bug', 'assistant: Editing a.ts'])
  expect(body.checkpoint?.seq).toBe(1)
  expect(body.costMicros).toBe(1500)
  expect(body.scrollback).toBeNull() // a past moment has no terminal snapshot
  const live = await replayRoute('/api/replay/state', 'GET', new URLSearchParams(`workspace=ws-1&node=n1&t=${Date.now() + 60_000}`), async () => deps)
  expect((live!.body as { scrollback: { text: string } }).scrollback.text).toContain('npm test')
})

test('validation: unknown workspace/node, bad range, wrong method, ledger off', async () => {
  const q = (s: string) => replayRoute('/api/replay', 'GET', new URLSearchParams(s), async () => deps)
  expect((await q('workspace=nope'))?.status).toBe(404)
  expect((await q('workspace=ws-1&node=ghost'))?.status).toBe(404)
  expect((await q(`workspace=ws-1&from=${T0 + 5}&to=${T0}`))?.status).toBe(400)
  expect((await replayRoute('/api/replay', 'POST', new URLSearchParams('workspace=ws-1'), async () => deps))?.status).toBe(405)
  expect((await replayRoute('/api/replay', 'GET', new URLSearchParams('workspace=ws-1'), async () => null))?.status).toBe(503)
  expect(await replayRoute('/api/replayx', 'GET', new URLSearchParams(), async () => deps)).toBeNull()
  expect((await replayRoute('/api/replay/state', 'GET', new URLSearchParams('workspace=ws-1'), async () => deps))?.status).toBe(400)
})

// --- checkpoint diff against a real temp repo --------------------------------------------------
const run = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } // test-only
let dir = ''
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = '' })

test('checkpointAt: diff of checkpoint N against N-1, chosen by the checkpoint ts', async () => {
  dir = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-replay-test-')))
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: GIT_ENV })
  await fs.writeFile(npath.join(dir, 'a.txt'), 'one\n')
  await run('git', ['add', '.'], { cwd: dir, env: GIT_ENV })
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: GIT_ENV })
  const repo = (await repoOf(dir))!
  await createCheckpoint(repo, 'ws-r', { reason: 'prompt', nodeId: null, eventSeq: null, ts: T0 + 10 })
  await fs.writeFile(npath.join(dir, 'a.txt'), 'two\n')
  await fs.writeFile(npath.join(dir, 'b.txt'), 'new\n')
  await createCheckpoint(repo, 'ws-r', { reason: 'prompt', nodeId: null, eventSeq: null, ts: T0 + 20 })

  expect(await checkpointAt('ws-r', dir, T0 + 5)).toBeNull()
  const first = await checkpointAt('ws-r', dir, T0 + 15)
  expect(first).toMatchObject({ seq: 1, baseSeq: null, files: [] })
  const second = await checkpointAt('ws-r', dir, T0 + 25)
  expect(second?.seq).toBe(2)
  expect(second?.baseSeq).toBe(1)
  expect(second?.files).toEqual([{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'b.txt' }])
  expect(second?.patch).toContain('+two')
  expect(checkpointBefore([], T0)).toBeNull()
}, 30_000)
