import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch } from './ca2Routes'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { freshDb, T0 } from './guard/controlGuard.testutil'
import { GOOD_BODY, GOOD_TITLE } from './skills/skillDraft.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const DRAFT = { title: GOOD_TITLE, description: 'Summarize status. Use when asked.', body: GOOD_BODY, caps: ['portfolio.read'], audience: 'central' as const }
const NAME = 'webterm-demo-skill'
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
const seed = async () => { await h.skills?.propose({ name: NAME, ...DRAFT }, 'central:c1'); await post(NAME, 'approve', { version: '1', phrase: CONFIRM_PHRASE }) }
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

describe('human write routes are removed', () => {
  it('create answers 405, versions and fork are not routes, and the list route still carries title and the library fields', async () => {
    await seed()
    expect(await call('POST', '/api/central/skills', { name: 'webterm-x', ...DRAFT })).toMatchObject({ status: 405 })
    for (const verb of ['versions', 'fork']) expect(await post(NAME, verb, DRAFT)).toBeNull()
    expect(h.skills?.list('pending_approval')).toEqual([])
    const row = (await listed()).find((i) => i.record.name === NAME)
    expect(row).toMatchObject({ record: { title: GOOD_TITLE, origin: 'central', status: 'active' }, description: DRAFT.description })
    expect(row?.body).toContain('## Purpose')
  })
})

describe('approve needs the typed phrase', () => {
  it('reviewed:true is ignored: every draft stays pending until the exact phrase arrives', async () => {
    for (const [name, by] of [['webterm-c-demo', 'central:c1'], ['webterm-a-demo', 'agent:n1']] as const) {
      await h.skills?.propose({ name, ...DRAFT, audience: by.startsWith('agent:') ? 'canvas' as const : 'central' as const }, by)
      expect(await post(name, 'approve', { version: '1', reviewed: true })).toMatchObject({ status: 400, body: { error: 'confirm_phrase_mismatch' } })
      expect(h.skills?.load(name)).toBeNull()
      expect(await post(name, 'approve', { version: '1', phrase: CONFIRM_PHRASE }, 'central:c1')).toMatchObject({ status: 403, body: { error: 'human_only' } })
      expect(await post(name, 'approve', { version: '1', phrase: CONFIRM_PHRASE })).toMatchObject({ status: 200 })
      expect(h.skills?.load(name)).not.toBeNull()
    }
  })
})
