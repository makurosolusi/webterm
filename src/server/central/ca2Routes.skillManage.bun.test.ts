import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch } from './ca2Routes'
import { freshDb, T0 } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const DRAFT = { description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.', caps: ['portfolio.read'], audience: 'central' as const }
const NAME = 'webterm-human-demo'
const ENV = { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_CENTRAL_MEMORY: 'on', WEBTERM_CENTRAL_MODEL: 'vendor/model:free', WEBTERM_CENTRAL_SKILLS: 'on' }
let dir: string
let h: Ca2Handle

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca2-skill-manage-'))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0, env: ENV })
  if (!booted) throw new Error('boot failed')
  h = booted
})
afterEach(() => { h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

const call = (method: string, path: string, body: unknown = {}, actor?: string) =>
  ca2Dispatch(h, { method, path, query: new URL(path, 'http://x').searchParams, body: async () => body }, actor)
const post = (name: string, verb: string, body: unknown = {}, actor?: string) => call('POST', `/api/central/skills/${name}/${verb}`, body, actor)
const seed = async () => { await call('POST', '/api/central/skills', { name: NAME, ...DRAFT }); await post(NAME, 'approve', { version: '1', reviewed: true }) }
const listed = async () => ((await call('GET', '/api/central/skills'))?.body as { items: Array<Record<string, any>> }).items

describe('enable and disable', () => {
  it('are human-only, flip load/index, and show enabled:false in the list', async () => {
    await seed()
    expect(await post(NAME, 'disable', {}, 'central:c1')).toMatchObject({ status: 403, body: { error: 'human_only' } })
    expect(h.skills?.load(NAME)).not.toBeNull()
    expect(await post(NAME, 'disable')).toMatchObject({ status: 200, body: { enabled: false } })
    expect(h.skills?.load(NAME)).toBeNull()
    expect((await listed()).find((i) => i.record.name === NAME)?.record.enabled).toBe(false)
    const active = ((await ca2Dispatch(h, { method: 'GET', path: '/api/central/skills', query: new URLSearchParams('status=active'), body: async () => ({}) }))?.body as { items: Array<{ name: string }> }).items
    expect(active.some((s) => s.name === NAME)).toBe(false)
    expect(await post(NAME, 'enable')).toMatchObject({ status: 200, body: { enabled: true } })
    expect(h.skills?.load(NAME)).not.toBeNull()
    expect(await post('webterm-nope', 'enable')).toMatchObject({ status: 404 })
  })

  it('builtin skills can be disabled', async () => {
    expect(await post('webterm-central-basics', 'disable')).toMatchObject({ status: 200 })
    expect(h.skills?.load('webterm-central-basics')).toBeNull()
  })
})

describe('POST /skills/:name/versions', () => {
  it('creates version 2 through the lifecycle, refuses non-humans, builtin, unknown names and a second open draft', async () => {
    await seed()
    const edit = { ...DRAFT, body: '1. Read the portfolio.\n2. Write ten lines.' }
    expect(await post(NAME, 'versions', edit, 'agent:n1')).toMatchObject({ status: 403, body: { error: 'human_only' } })
    expect(await post(NAME, 'versions', { ...edit, body: ' ' })).toMatchObject({ status: 400, body: { error: 'invalid_body' } })
    expect(await post(NAME, 'versions', edit)).toMatchObject({ status: 201, body: { name: NAME, version: '2', state: 'pending_approval' } })
    expect(h.skills?.load(NAME)?.record.version).toBe('1')
    expect(await post(NAME, 'versions', edit)).toMatchObject({ status: 409, body: { error: 'limit' } })
    expect(await post('webterm-central-basics', 'versions', edit)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(await post('webterm-unknown', 'versions', edit)).toMatchObject({ status: 404 })
  })
})

describe('POST /skills/:name/fork', () => {
  it('copies a builtin into webterm-<base>-copy, then -copy-2 when taken, as a human draft', async () => {
    const one = await post('webterm-central-basics', 'fork')
    expect(one).toMatchObject({ status: 201, body: { name: 'webterm-central-basics-copy', version: '1', state: 'pending_approval' } })
    expect(await post('webterm-central-basics', 'fork')).toMatchObject({ status: 201, body: { name: 'webterm-central-basics-copy-2' } })
    expect((await listed()).find((i) => i.record.name === 'webterm-central-basics-copy')).toMatchObject({ record: { origin: 'human' } })
    expect(await post('webterm-central-basics', 'fork', {}, 'central:c1')).toMatchObject({ status: 403 })
  })
})

describe('approve with reviewed:true', () => {
  it('activates a human draft in one call; central and agent drafts answer 403 forbidden and stay pending', async () => {
    await seed()
    expect(h.skills?.load(NAME)?.record.origin).toBe('human')
    for (const [name, by] of [['webterm-c-demo', 'central:c1'], ['webterm-a-demo', 'agent:n1']] as const) {
      await h.skills?.propose({ name, ...DRAFT, audience: by.startsWith('agent:') ? 'canvas' as const : 'central' as const }, by)
      expect(await post(name, 'approve', { version: '1', reviewed: true })).toMatchObject({ status: 403, body: { error: 'forbidden' } })
      expect(h.skills?.load(name)).toBeNull()
    }
    expect(await post(NAME, 'approve', { version: '1', reviewed: true }, 'central:c1')).toMatchObject({ status: 403, body: { error: 'human_only' } })
  })
})
