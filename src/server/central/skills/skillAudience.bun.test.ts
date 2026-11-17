// Audience matrix on a real Ca2 handle: who sees which active skill (agent list/get vs Central), required audience on
// every entry (human route, agent route), edit keeps audience, fork can change it.
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

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const DRAFT = { description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.\n2. Write five lines.', caps: [] as string[] }
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
  expect((await human('/api/central/skills', { name, ...DRAFT, audience }))?.status).toBe(201)
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

describe('audience on every proposal entry', () => {
  it('human create answers 400 invalid_audience naming the allowed values (also for the removed `both`); nothing stored', async () => {
    for (const audience of [undefined, 'everyone', 'both', 'agents']) {
      const r = await human('/api/central/skills', { name: 'webterm-noaud', ...DRAFT, ...(audience ? { audience } : {}) })
      expect(r).toMatchObject({ status: 400, body: { error: 'invalid_audience', allowed: ['central', 'canvas'] } })
    }
    expect(h.skills?.list('pending_approval')).toEqual([])
  })
  it('agent route: no audience is forced to canvas, central is 403 audience_forbidden, junk is 400 invalid_audience', async () => {
    expect((await agentSkillPropose(h, { name: 'webterm-agent-default', ...DRAFT }, 'n1')).status).toBe(201)
    expect(h.skills?.list('pending_approval')[0]).toMatchObject({ origin: 'agent', audience: 'canvas' })
    expect(await agentSkillPropose(h, { name: 'webterm-agent-central', ...DRAFT, audience: 'central' }, 'n1')).toMatchObject({ status: 403, body: { error: 'audience_forbidden' } })
    expect(await agentSkillPropose(h, { name: 'webterm-agent-junk', ...DRAFT, audience: 'both' }, 'n1')).toMatchObject({ status: 400, body: { error: 'invalid_audience' } })
    expect(h.skills?.list('pending_approval').map((r) => r.name)).toEqual(['webterm-agent-default'])
  })
  it('humans may create either kind', async () => {
    expect((await human('/api/central/skills', { name: 'webterm-h-central', ...DRAFT, audience: 'central' }))?.status).toBe(201)
    expect((await human('/api/central/skills', { name: 'webterm-h-canvas', ...DRAFT, audience: 'canvas' }))?.status).toBe(201)
  })
})

describe('edit keeps the kind; fork changes it', () => {
  it('human versions without audience keeps it; a different audience is 400 audience_immutable', async () => {
    await activate('webterm-e-demo', 'canvas')
    expect((await human('/api/central/skills/webterm-e-demo/versions', { ...DRAFT, body: '1. New body.' }))?.status).toBe(201)
    expect(h.skills?.list('pending_approval')[0]).toMatchObject({ version: '2', audience: 'canvas' })
    expect((await human('/api/central/skills/webterm-e-demo/reject', { version: '2' }))?.status).toBe(200)
    expect(await human('/api/central/skills/webterm-e-demo/versions', { ...DRAFT, audience: 'central' })).toMatchObject({ status: 400, body: { error: 'audience_immutable' } })
    expect(h.skills?.list('pending_approval')).toEqual([])
  })
  it('agent edit keeps the audience; an agent can neither see nor edit a central skill', async () => {
    await activate('webterm-e-canvas', 'canvas')
    await activate('webterm-e-central', 'central')
    expect((await agentSkillPropose(h, { name: 'webterm-e-canvas', edit: true, body: '1. Other.' }, 'n1')).status).toBe(201)
    expect(h.skills?.list('pending_approval')[0]).toMatchObject({ version: '2', audience: 'canvas' })
    expect(await agentSkillPropose(h, { name: 'webterm-e-central', edit: true, body: '1. Other.' }, 'n1')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    expect(await agentSkillPropose(h, { name: 'webterm-e-canvas', edit: true, audience: 'central' }, 'n1')).toMatchObject({ status: 403 })
  })
  it('fork copies the kind, or takes the selected one; an invalid one is 400', async () => {
    await activate('webterm-f-demo', 'canvas')
    expect((await human('/api/central/skills/webterm-f-demo/fork', {}))?.status).toBe(201)
    expect(await human('/api/central/skills/webterm-f-demo/fork', { audience: 'both' })).toMatchObject({ status: 400, body: { error: 'invalid_audience' } })
    expect((await human('/api/central/skills/webterm-f-demo/fork', { audience: 'central' }))?.status).toBe(201)
    expect(h.skills?.list('pending_approval').map((r) => r.audience).sort()).toEqual(['canvas', 'central'])
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
