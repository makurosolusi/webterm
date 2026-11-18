// Central's browser tools and browser profiles: browser_open `profile`, browser_status profiles, browser_profile, and the
// idle-reuse rule (only the SAME profile). The profile registry is the real service (browser.profiles.service) wired through
// `createBrowserToolDeps`, so this also covers the production port (ledger note for an agent-made profile included).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_BROWSER, type BrowserState } from '../../../../shared/browser.contract'
import { WORKSPACE_HUES } from '../../../../shared/workspaceColor'
import { makeRig, ws, type Rig } from '../../../browser/browser.profiles.testkit'
import { setActiveProfiles } from '../../../browser/browser.profiles.service'
import { createBrowserToolDeps } from '../../ca2Boot.browser'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import { BROWSER_ACT_FLAG, createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

const ENV = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
let f: Fixture
let rig: Rig
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db); rig = makeRig([ws('w-p1', 'Alpha')]); setActiveProfiles(rig.svc) })
afterEach(() => { unregister(); setActiveProfiles(null); f.close() })

const st = (id: string): BrowserState => ({ id, url: 'https://a.example/', title: 'T', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
interface Calls { open: unknown[][]; project: unknown[][] }

function setup(nodes: Array<Record<string, unknown>> = []) {
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: id, nodes, bridges: [] } as never : null))
  const calls: Calls = { open: [], project: [] }
  const base = createBrowserToolDeps({ [ENV_BROWSER.enabled]: 'on' }, { store: { mint: () => 't', revoke: () => false, verify: () => undefined } as never, active: () => null }) as BrowserToolDeps
  const deps: BrowserToolDeps = {
    ...base,
    state: (id) => (nodes.some((n) => n.id === id) ? st(id) : undefined),
    open: async (...a) => { calls.open.push(a); return { ok: true, started: true } },
    openProject: async (...a) => { calls.project.push(a); return { ok: true } },
  }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const run = (tool: string, args: Record<string, unknown>) => execTool({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env: ENV }, tool, { projectId: 'p1', ...args })
  return { calls, run, registry }
}
const made = (name: string) => { const r = rig.svc.create({ name }); if (!r.ok) throw new Error(r.code); return r.value }

describe('browser_open profile', () => {
  it('opens a standalone browser on the named profile (name, any case, or id); none = the board Default', async () => {
    const work = made('work')
    const s = setup()
    const byName = await s.run('browser_open', { profile: 'WORK', nodeId: 'br-1' })
    expect(byName).toMatchObject({ ok: true, data: { nodeId: 'br-1', profile: 'work' } })
    await s.run('browser_open', { profile: work.id, nodeId: 'br-2' })
    await s.run('browser_open', { nodeId: 'br-3' })
    expect(s.calls.project).toEqual([['w-p1', 'br-1', work.id], ['w-p1', 'br-2', work.id], ['w-p1', 'br-3', undefined]])
  })

  it('passes the resolved profile id to the agent-cabled open', async () => {
    const work = made('work')
    const s = setup()
    f.db.query("INSERT INTO central_agents (id, project_id, kind, runner, node_id, state, owner, started_at) VALUES ('ag', 'p1', 'claude', 'pty', 'c-ag', 'working', 'central:global', 1)").run()
    expect(await s.run('browser_open', { agentRef: 'ag', profile: 'Work', nodeId: 'br-9' })).toMatchObject({ ok: true, data: { agentId: 'ag', profile: 'work' } })
    expect(s.calls.open).toEqual([['c-ag', 'br-9', work.id]])
  })

  it('an unknown profile is denied and `next` lists the names that exist, so the agent is never stuck', async () => {
    made('work')
    made('personal')
    const s = setup()
    const r = await s.run('browser_open', { profile: 'nope' })
    expect(r).toMatchObject({ ok: false, code: 'profile_not_found', data: { profiles: expect.arrayContaining(['work', 'personal']) } })
    expect((r.data as { next: string }).next).toMatch(/Available: .*"work"/)
    expect(s.calls.project).toEqual([])
  })

  it('refuses a profile bound to another board with the same answer', async () => {
    const other = rig.svc.create({ name: 'theirs', workspaceId: 'w-p1' }) // bound to this board: fine
    expect(other.ok).toBe(true)
    rig.boards.push(ws('w-x', 'Other'))
    const foreign = rig.svc.create({ name: 'foreign', workspaceId: 'w-x' })
    const s = setup()
    expect(foreign.ok).toBe(true)
    expect(await s.run('browser_open', { profile: 'foreign' })).toMatchObject({ ok: false, code: 'profile_not_found' })
  })

  it('reuses an idle central browser only on the SAME profile', async () => {
    const work = made('work')
    const s = setup([{ id: 'br-w', kind: 'browser', profileId: work.id }, { id: 'br-d', kind: 'browser' }])
    expect(await s.run('browser_open', { profile: 'work' })).toMatchObject({ ok: true, data: { nodeId: 'br-w', reused: true, profile: 'work' } })
    expect(await s.run('browser_open', {})).toMatchObject({ ok: true, data: { nodeId: 'br-d', reused: true } })
    made('other')
    expect(await s.run('browser_open', { profile: 'other', nodeId: 'br-new' })).toMatchObject({ ok: true, data: { nodeId: 'br-new' } })
    expect(s.calls.project).toHaveLength(1)
  })
})

describe('browser_status profiles', () => {
  it('shows the profile (name + color) of every browser and the list of profiles', async () => {
    const work = made('work')
    const s = setup([{ id: 'br-w', kind: 'browser', profileId: work.id }, { id: 'br-d', kind: 'browser' }])
    const data = (await s.run('browser_status', {})).data as { items: Array<{ id: string; profile: { name: string; color: string } | null }>; profiles: Array<Record<string, unknown>> }
    const by = Object.fromEntries(data.items.map((i) => [i.id, i.profile]))
    expect(by['br-w']).toEqual({ name: 'work', color: work.color })
    expect(by['br-d']?.name).toBe('Default (Alpha)')
    expect(data.profiles.map((p) => p.name).sort()).toEqual(['Default (Alpha)', 'work'])
    expect(data.profiles.find((p) => p.name === 'work')).toMatchObject({ live: false, nodeCount: expect.any(Number), default: false })
    expect(JSON.stringify(data)).not.toMatch(/cookie/i)
  })
})

describe('browser_profile', () => {
  it('lists profiles; create picks a color no other profile uses and leaves an agent ledger note', async () => {
    const s = setup()
    const first = await s.run('browser_profile', { action: 'create', name: 'sales' })
    const color = (first.data as { profile: { color: string } }).profile.color
    expect(WORKSPACE_HUES as readonly string[]).toContain(color)
    // The Default profile already holds one hue: a new profile avoids it (and every other used hue) while hues are free.
    expect(color).not.toBe(rig.svc.list().find((p) => p.isDefaultOf)?.color)
    const second = await s.run('browser_profile', { action: 'create', name: 'support', color: 'violet' })
    expect(second).toMatchObject({ ok: true, data: { profile: { name: 'support', color: 'violet' } } })
    expect((await s.run('browser_profile', { action: 'list' })).data).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({ name: 'sales' }), expect.objectContaining({ name: 'support' })]) })
    expect(rig.notes).toEqual(['agent:created browser profile "sales"', 'agent:created browser profile "support"'])
  })

  it('refuses a duplicate or invalid name with a code (duplicate names the existing ones), and bad colors', async () => {
    made('work')
    const s = setup()
    const dup = await s.run('browser_profile', { action: 'create', name: 'WORK' })
    expect(dup).toMatchObject({ ok: false, code: 'profile_name_taken' })
    expect((dup.data as { next: string }).next).toContain('"work"')
    expect((await s.run('browser_profile', { action: 'create', name: '   ' })).code).toBe('profile_name_invalid')
    expect((await s.run('browser_profile', { action: 'create', name: 'x', color: 'chartreuse' })).code).toBe('bad_request')
  })

  it('offers no way to touch cookies or delete: the input is list|create only', async () => {
    const s = setup()
    expect((await s.run('browser_profile', { action: 'delete', name: 'x' })).code).toBe('invalid_shape')
    expect((await s.run('browser_profile', { action: 'export' })).code).toBe('invalid_shape')
    expect((await s.run('browser_profile', { action: 'list', cookies: true })).code).toBe('invalid_shape')
    const usage = s.registry.get('browser_profile')!
    expect(usage.tier).toBe('R1')
    expect(usage.usage).toMatch(/cannot read, import, export or delete cookies/)
  })
})
