// Bun: the assembled runtime over a FAKE CDP server (no real Chromium): the process pool is keyed by profile, the agent
// verb `open --profile` picks the right profile, reuse never crosses profiles, a node can move to another profile.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserProfile } from '../../shared/browser.profile'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import { CapabilityStore, allows } from '../control/capabilities'
import { createFileSecretStore } from '../envSecrets.store'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { startBrowserRuntime } from './browser.runtime'
import type { BrowserRuntime } from './browser.state'
import { listProfiles, resolveProfile } from './browser.profiles.service'
import { startFakeCdp, offlineAdblock } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

const ON = { [ENV_BROWSER.enabled]: 'on', [ENV_BROWSER.agent]: 'on' }
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

const agent = (id: string) => ({ id, kind: 'agent' as const, x: 0, y: 0 })
interface Rig {
  rt: BrowserRuntime; fake: FakeCdp; board: Workspace; other: Workspace
  acquired: string[]; stopped: string[]; frames: unknown[]; live: Set<string>
}

async function boot(env: Record<string, string> = ON): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-bprof-'))
  const fake = await startFakeCdp()
  const board: Workspace = { id: 'w1', name: 'Alpha', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [agent('a1'), agent('a2')] }
  const other: Workspace = { id: 'w2', name: 'Beta', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [] }
  const acquired: string[] = []
  const stopped: string[] = []
  const frames: unknown[] = []
  const live = new Set<string>()
  let seq = 0
  const rt = await startBrowserRuntime({
    env, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')), workspaces: () => [board, other],
    launcher: { acquire: async (id) => { acquired.push(id); live.add(id); return fake.url }, shutdown: () => undefined, isLive: (id) => live.has(id), stop: (id) => { stopped.push(id); live.delete(id) } },
    adblock: offlineAdblock(), broadcast: (m) => { frames.push(m) },
    canvas: {
      add(input) { board.nodes.push(...input.nodes); board.bridges.push(...(input.bridges ?? [])); return { ok: true, updatedAt: ++seq, nodes: input.nodes } },
      workspaceOfNode: (id) => (board.nodes.some((n) => n.id === id) ? board : null),
    },
  })
  if (!rt) throw new Error('runtime did not start')
  cleanup.push(async () => { forgetNodeToken('a1'); forgetNodeToken('a2'); await rt.shutdown(); await fake.close(); rmSync(dir, { recursive: true, force: true }) })
  return { rt, fake, board, other, acquired, stopped, frames, live }
}

// the version probe also asks for a process per profile, so "which processes" = distinct keys, in first-use order
const uniq = (xs: string[]): string[] => [...new Set(xs)]
const body = (v?: unknown) => async () => (v === undefined ? '' : JSON.stringify(v))
const api = (r: Rig, method: string, path: string, v?: unknown) => r.rt.api(method, `/api/browser${path}`, body(v))
const caps = new CapabilityStore()
const open = (r: Rig, who: string, payload: unknown = {}) =>
  r.rt.control({ method: 'POST', path: '/api/control/browser/open', body: payload, headers: { [TOKEN_HEADER]: nodeToken(who) } }, { verify: (t: string) => caps.verify(t), allows })
const created = async (r: Rig, name: string) => (await api(r, 'POST', '/profiles', { name }))!.body as BrowserProfile

describe('profile-keyed process pool', () => {
  test('without `profile` an agent gets the workspace Default (old behavior, id = workspace id)', async () => {
    const r = await boot()
    const res = await open(r, 'a1')
    expect(res?.status).toBe(200)
    expect(uniq(r.acquired)).toEqual(['w1'])
    expect(r.board.nodes.find((n) => n.kind === 'browser')?.profileId).toBe(undefined)
  })

  test('`open profile=<name>` (any case) picks that profile; two nodes on it share ONE process, another profile gets its own', async () => {
    const r = await boot()
    const a = await created(r, 'Admin')
    const b = await created(r, 'Viewer')
    const one = await open(r, 'a1', { profile: 'ADMIN' })
    const two = await open(r, 'a2', { profile: a.id })
    expect(one?.status).toBe(200)
    expect(two?.status).toBe(200)
    expect(uniq(r.acquired)).toEqual([a.id]) // two nodes, one Chromium
    const browsers = r.board.nodes.filter((n) => n.kind === 'browser')
    expect(browsers.map((n) => n.profileId)).toEqual([a.id, a.id])
    expect(JSON.stringify(one?.body)).toContain('on profile')
    await open(r, 'a1', { profile: 'Viewer' })
    expect(uniq(r.acquired)).toEqual([a.id, b.id]) // different profile = separate process
    expect(r.rt.status().live).toBe(3)
  })

  test('reuse never hands out the wrong account: same profile reuses, a different one opens a new node', async () => {
    const r = await boot()
    const a = await created(r, 'Admin')
    const b = await created(r, 'Viewer')
    const openFor = r.rt.openFor!
    expect(await openFor('a1', 'n1', 'Admin')).toMatchObject({ ok: true, nodeId: 'n1' })
    expect(await openFor('a1', 'n2', 'Admin')).toMatchObject({ ok: true, nodeId: 'n1', reused: true }) // same profile: reuse
    expect(await openFor('a1', 'n3', 'Viewer')).toMatchObject({ ok: true, nodeId: 'n3' }) // other account: never n1
    expect(await openFor('a1', 'n4', 'Viewer')).toMatchObject({ nodeId: 'n3', reused: true })
    expect(r.board.nodes.filter((n) => n.kind === 'browser').map((n) => [n.id, n.profileId])).toEqual([['n1', a.id], ['n3', b.id]])
  })

  test('openProject (Central browser_read) takes a profile too; an unknown one adds nothing', async () => {
    const r = await boot()
    const a = await created(r, 'Admin')
    expect(await r.rt.openProject!('w1', 'p1', 'admin')).toEqual({ ok: true, nodeId: 'p1' })
    expect(r.board.nodes.find((n) => n.id === 'p1')?.profileId).toBe(a.id)
    expect(await r.rt.openProject!('w1', 'p2', 'ghost')).toEqual({ ok: false, code: 'profile_not_found' })
    expect(r.board.nodes.some((n) => n.id === 'p2')).toBe(false)
  })

  test('an unknown profile (or another board\'s) is refused with the list of names, and adds no node', async () => {
    const r = await boot()
    await created(r, 'Admin')
    const bad = await open(r, 'a1', { profile: 'Nope' })
    expect(bad).toMatchObject({ status: 404, body: { error: 'profile_not_found' } })
    expect(JSON.stringify(bad?.body)).toContain('Admin')
    expect(JSON.stringify(bad?.body)).toContain('Default (Alpha)')
    const foreign = await open(r, 'a1', { profile: 'w2' }) // Beta's Default is not Alpha's agent's to use
    expect(foreign).toMatchObject({ status: 404, body: { error: 'profile_not_found' } })
    expect(r.board.nodes.filter((n) => n.kind === 'browser')).toHaveLength(0)
    expect(await open(r, 'a1', { profile: 5 })).toMatchObject({ status: 400 })
  })

  test('a node moves to another profile: its page reopens in the new process, the node is counted there', async () => {
    const r = await boot()
    const a = await created(r, 'Admin')
    await open(r, 'a1')
    const id = r.board.nodes.find((n) => n.kind === 'browser')!.id
    expect(uniq(r.acquired)).toEqual(['w1'])
    const moved = await api(r, 'POST', `/${id}/profile`, { profileId: a.id })
    expect(moved).toMatchObject({ status: 200, body: { profileId: a.id } })
    expect(uniq(r.acquired)).toEqual(['w1', a.id])
    expect(r.rt.state(id)?.live).toBe('live')
    const list = ((await api(r, 'GET', '/profiles'))!.body as { profiles: BrowserProfile[] }).profiles
    expect(list.find((p) => p.id === a.id)?.nodeCount).toBe(1)
    expect(list.find((p) => p.id === 'w1')?.nodeCount).toBe(0)
    expect(await api(r, 'POST', `/${id}/profile`, { profileId: 'bp-ghost' })).toMatchObject({ status: 404 })
    expect(await api(r, 'POST', `/${id}/profile`, { profileId: 'w2' })).toMatchObject({ status: 400 }) // another board's Default
  })

  test('delete is refused while a node uses the profile; after the node is gone it stops the profile process', async () => {
    const r = await boot()
    const a = await created(r, 'Admin')
    await open(r, 'a1', { profile: 'Admin' })
    expect(await api(r, 'DELETE', `/profiles/${a.id}`)).toMatchObject({ status: 409, body: { error: 'profile_in_use' } })
    const id = r.board.nodes.find((n) => n.kind === 'browser')!.id
    await r.rt.closeNode(id)
    r.board.nodes = r.board.nodes.filter((n) => n.id !== id)
    expect(await api(r, 'DELETE', `/profiles/${a.id}`)).toEqual({ status: 204 })
    expect(r.stopped).toEqual([a.id])
  })

  test('MAX_LIVE gate counts pages across profiles (one gate, never bypassed by switching profile)', async () => {
    const r = await boot({ ...ON, [ENV_BROWSER.maxLive]: '1' })
    await created(r, 'Admin')
    const first = await open(r, 'a1', { profile: 'Admin' })
    expect(first?.status).toBe(200)
    const second = await open(r, 'a2')
    expect(second).toMatchObject({ body: { reason: 'max_live' } }) // slot taken by the other profile's page
    expect(r.rt.status().live).toBe(1)
  })

  test('windows hear about list changes and process start/stop (`browserProfiles` frame)', async () => {
    const r = await boot()
    r.frames.length = 0
    await created(r, 'Admin')
    expect(r.frames.some((f) => (f as { t: string }).t === 'browserProfiles')).toBe(true)
    r.frames.length = 0
    await open(r, 'a1')
    expect(r.frames.length).toBeGreaterThan(0) // the Default profile went live
  })

  test('Central-facing service: list / resolve / create are reachable without HTTP and die with the runtime', async () => {
    const r = await boot()
    expect(listProfiles('w1').map((p) => p.id)).toEqual(['w1'])
    expect(resolveProfile('default (alpha)', 'w1')?.id).toBe('w1')
    await r.rt.shutdown()
    expect(listProfiles()).toEqual([])
  })
})
