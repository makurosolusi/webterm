// Audience matrix on a real Ca2 handle: who sees which active skill (agent list/get vs Central), required audience on
// the agent entry, edit keeps audience; the human create/edit/fork routes are gone.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIRM_PHRASE } from '../../../shared/approvalConfirm'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import type { SessionsLike } from '../../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from '../ca2Boot'
import { agentSkillList, agentSkillPropose } from '../ca2Routes.agentSkill'
import { ca2Dispatch } from '../ca2Routes'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { CORE_DEFS } from '../tools/defs/core.defs'
import { createRegistry } from '../tools/toolRegistry'
import { GOOD_BODY, GOOD_TITLE, tpl } from './skillDraft.testutil'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const DRAFT = { title: GOOD_TITLE, description: 'Summarize status. Use when asked.', body: GOOD_BODY, caps: [] as string[] }
let dir: string
let h: Ca2Handle

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audience-matrix-'))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({
    runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0,
    env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_MEMORY: 'on', WEBTERM_CENTRAL_MODEL: 'vendor/model:free' },
  })
  if (!booted) throw new Error('boot failed')
  h = booted
  h.skills?.installBuiltins()
})
afterEach(() => { h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

const human = (path: string, body: unknown) => ca2Dispatch(h, { method: 'POST', path, query: new URLSearchParams(), body: async () => body }, 'human:ui')
async function activate(name: string, audience: string): Promise<void> {
  // Skills are written by an author: Central's own proposals for `central`, an agent session's for `canvas`.
  await h.skills?.propose({ name, ...DRAFT, audience: audience as 'central' | 'canvas' }, audience === 'canvas' ? 'agent:n9' : 'central:c1')
  expect((await human(`/api/central/skills/${name}/approve`, { version: '1', phrase: CONFIRM_PHRASE }))?.status).toBe(200)
}
const names = (r: { body: unknown }) => (r.body as { items: Array<{ name: string; status: string }> }).items.filter((i) => i.status === 'active').map((i) => i.name).sort()

describe('visibility matrix', () => {
  it('agents see only active canvas skills (never central ones, built-ins included); Central index and load only central', async () => {
    await activate('webterm-m-central', 'central')
    await activate('webterm-m-canvas', 'canvas')
    // Attachment is the cable (skillAttach.bun.test.ts); here every name is "attached" to prove a central one is unreachable even then.
    const hiddenNames = ['webterm-m-central', 'webterm-central-basics', 'webterm-approval-flow', 'webterm-project-status', 'webterm-skill-authoring']
    const attached = ['webterm-m-canvas', ...hiddenNames]
    expect(names(agentSkillList(h, 'n1', undefined, attached))).toEqual(['webterm-m-canvas'])
    expect(agentSkillList(h, 'n1', 'webterm-m-canvas', attached).status).toBe(200)
    for (const hidden of hiddenNames) {
      expect([hidden, agentSkillList(h, 'n1', hidden, attached).status]).toEqual([hidden, 404])
    }
    const got = agentSkillList(h, 'n1', 'webterm-m-canvas', attached).body as { skill: { audience: string; body: string } }
    expect(got.skill).toMatchObject({ audience: 'canvas' })
    expect(got.skill.body).toContain('Write five lines')
    const index = h.skills?.index().map((e) => e.name) ?? []
    expect(index).not.toContain('webterm-m-canvas')
    expect(index).toEqual(expect.arrayContaining(['webterm-m-central', 'webterm-central-basics']))
  })

  it('a disabled canvas skill disappears from the agent list and get', async () => {
    await activate('webterm-m-off', 'canvas')
    await human('/api/central/skills/webterm-m-off/disable', {})
    expect(names(agentSkillList(h, 'n1', undefined, ['webterm-m-off']))).toEqual([])
    expect(agentSkillList(h, 'n1', 'webterm-m-off', ['webterm-m-off'])).toMatchObject({ status: 404, body: { error: 'unavailable' } })
  })
})

describe('audience on the agent proposal entry', () => {
  it('no audience is forced to canvas, central is 403 audience_forbidden, junk is 400 invalid_audience', async () => {
    expect((await agentSkillPropose(h, { name: 'webterm-agent-default', ...DRAFT }, 'n1')).status).toBe(201)
    expect(h.skills?.list('pending_approval')[0]).toMatchObject({ origin: 'agent', audience: 'canvas', title: GOOD_TITLE })
    expect(await agentSkillPropose(h, { name: 'webterm-agent-central', ...DRAFT, audience: 'central' }, 'n1')).toMatchObject({ status: 403, body: { error: 'audience_forbidden' } })
    expect(await agentSkillPropose(h, { name: 'webterm-agent-junk', ...DRAFT, audience: 'both' }, 'n1')).toMatchObject({ status: 400, body: { error: 'invalid_audience' } })
    expect(h.skills?.list('pending_approval').map((r) => r.name)).toEqual(['webterm-agent-default'])
  })
  it('the title is required and validated (400 invalid_title); a thin body is 400 invalid with the structure issues', async () => {
    for (const title of [undefined, '', 'ab', '**x**']) expect(await agentSkillPropose(h, { name: 'webterm-agent-t', ...DRAFT, title }, 'n1')).toMatchObject({ status: 400, body: { error: 'invalid_title' } })
    const thin = await agentSkillPropose(h, { name: 'webterm-agent-t', ...DRAFT, body: '1. One.\n2. Two.' }, 'n1')
    expect(thin).toMatchObject({ status: 400, body: { error: 'invalid', issues: expect.arrayContaining(['structure', 'structure:missing ## Purpose']) } })
    expect(h.skills?.list().some((r) => r.name === 'webterm-agent-t')).toBe(false)
  })
})

describe('the human write routes are gone', () => {
  it('create is 405, versions and fork match no route (null: 404 downstream), and nothing is stored', async () => {
    expect(await human('/api/central/skills', { name: 'webterm-x', ...DRAFT, audience: 'central' })).toMatchObject({ status: 405 })
    for (const verb of ['versions', 'fork']) expect(await human(`/api/central/skills/webterm-central-basics/${verb}`, { ...DRAFT })).toBeNull()
    expect(h.skills?.list('pending_approval')).toEqual([])
  })
})

describe('edit keeps the kind', () => {
  it('agent edit keeps the audience and the title; an agent can neither see nor edit a central skill', async () => {
    await activate('webterm-e-canvas', 'canvas')
    await activate('webterm-e-central', 'central')
    expect((await agentSkillPropose(h, { name: 'webterm-e-canvas', edit: true, body: tpl('Other.') }, 'n1')).status).toBe(201)
    expect(h.skills?.list('pending_approval')[0]).toMatchObject({ version: '2', audience: 'canvas', title: GOOD_TITLE })
    expect(await agentSkillPropose(h, { name: 'webterm-e-central', edit: true, body: tpl('Other.') }, 'n1')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    expect(await agentSkillPropose(h, { name: 'webterm-e-canvas', edit: true, audience: 'central' }, 'n1')).toMatchObject({ status: 403 })
  })
  it('a different kind for an existing name is audience_immutable at the store', async () => {
    await activate('webterm-e-demo', 'canvas')
    const err = await h.skills?.propose({ name: 'webterm-e-demo', ...DRAFT, audience: 'central' }, 'central:c2').catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('audience_immutable')
  })
  it('an edit of an active skill given a new title replaces it', async () => {
    await activate('webterm-e-title', 'canvas')
    expect((await agentSkillPropose(h, { name: 'webterm-e-title', edit: true, title: 'Better title' }, 'n1')).status).toBe(201)
    expect(h.skills?.list('pending_approval')[0].title).toBe('Better title')
  })
})

describe('review list', () => {
  it('carries the audience on each record', async () => {
    await activate('webterm-r-demo', 'canvas')
    const res = await ca2Dispatch(h, { method: 'GET', path: '/api/central/skills', query: new URLSearchParams(), body: async () => ({}) })
    const items = (res?.body as { items: Array<{ record: { name: string; audience: string } }> }).items
    expect(items.find((i) => i.record.name === 'webterm-r-demo')?.record.audience).toBe('canvas')
  })
})
