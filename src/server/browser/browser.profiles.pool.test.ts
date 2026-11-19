// The Chromium pool and the host are keyed by PROFILE: same profile = one process shared by its nodes, different
// profile = its own process and user-data dir; the launcher can say what runs and stop one profile.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createChromiumPool } from './chromium.launch'
import type { ChildLike } from './chromium.launch'
import { makeHostRig, stubGuard } from './fakeCdp.testkit'
import { classifyBrowserNode } from './browser.idle'
import type { IdlePorts } from './browser.idle'

class Child implements ChildLike {
  pid = 4242
  signals: string[] = []
  stderr = { on: () => undefined }
  once() { /* exit never fires in this test */ }
  kill(sig?: NodeJS.Signals) { this.signals.push(sig ?? 'SIGTERM'); return true }
}

function pool() {
  const children: Child[] = []
  const argv: string[][] = []
  const p = createChromiumPool({
    env: { WEBTERM_DATA_DIR: '/d' }, platform: 'darwin', dataRoot: mkdtempSync(join(tmpdir(), 'wt-pool-')), proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
    deps: { spawn: (_b, a) => { const c = new Child(); children.push(c); argv.push(a); return c }, readFile: () => '9222\n/devtools/browser/x', sleep: async () => undefined },
  })
  return { p, children, argv }
}
const userDataDir = (a: string[]): string => (a.find((x) => x.startsWith('--user-data-dir=')) ?? '').split('=')[1]

describe('pool keyed by profile', () => {
  it('one process per profile, each in its own user-data dir; the same profile reuses its process', async () => {
    const { p, children, argv } = pool()
    await p.acquire('bp-a')
    await p.acquire('bp-a')
    await p.acquire('bp-b')
    expect(children).toHaveLength(2)
    expect(userDataDir(argv[0])).toMatch(/profiles\/bp-a$/)
    expect(userDataDir(argv[1])).toMatch(/profiles\/bp-b$/)
  })
  it('isLive reports running profiles; stop kills only that profile\'s process and a later acquire starts a new one', async () => {
    const { p, children } = pool()
    await p.acquire('bp-a')
    await p.acquire('bp-b')
    expect([p.isLive?.('bp-a'), p.isLive?.('bp-b'), p.isLive?.('bp-c')]).toEqual([true, true, false])
    p.stop?.('bp-a')
    await new Promise((r) => setTimeout(r, 0)) // kill runs on the launch promise's continuation
    expect(children[0].signals).toContain('SIGTERM')
    expect(children[1].signals).toEqual([])
    expect(p.isLive?.('bp-a')).toBe(false)
    await p.acquire('bp-a')
    expect(children).toHaveLength(3)
  })
  it('rejects a profile id that could escape the data dir', async () => {
    await expect(pool().p.acquire('../evil')).rejects.toThrow()
  })
})

describe('host resolves the profile per node', () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => { await stop?.() })

  it('nodes on the same profile share one launch; another profile launches separately; no resolver = workspace Default', async () => {
    const acquired: string[] = []
    const profileOf = (nodeId: string): string => (nodeId === 'n3' ? 'bp-b' : nodeId.startsWith('n') ? 'bp-a' : 'w1')
    const rig = await makeHostRig(stubGuard(), { profileOf, launcher: { acquire: async (id: string) => { acquired.push(id); return rigUrl() }, shutdown: () => undefined } })
    stop = rig.stop
    function rigUrl(): string { return rig.fake.url }
    await rig.host.open('n1', 'w1', 'https://a.test/')
    await rig.host.open('n2', 'w1', 'https://a.test/')
    await rig.host.open('n3', 'w1', 'https://b.test/')
    expect(acquired).toEqual(['bp-a', 'bp-b'])
    expect([rig.host.profileOf('n1'), rig.host.profileOf('n2'), rig.host.profileOf('n3')]).toEqual(['bp-a', 'bp-a', 'bp-b'])
  })
  it('without a resolver a node uses its workspace Default (old behavior)', async () => {
    const acquired: string[] = []
    const rig = await makeHostRig(stubGuard(), { launcher: { acquire: async (id: string) => { acquired.push(id); return rig.fake.url }, shutdown: () => undefined } })
    stop = rig.stop
    await rig.host.open('n1', 'w9', 'https://a.test/')
    expect(acquired).toEqual(['w9'])
  })
})

describe('idle reuse is profile-aware', () => {
  const ports = (profiles: Record<string, string>): IdlePorts => ({
    stateOf: (id) => ({ id, url: '', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' }),
    bridgesOf: () => [], hasNode: () => true, agentOfNode: () => null, focusedNode: () => null,
    profileOf: (_w, id) => profiles[id],
  })
  it('a Central browser is idle for the profile it runs, other_profile for any other', () => {
    const p = ports({ 'br-1': 'bp-a' })
    expect(classifyBrowserNode(p, 'w1', 'br-1')).toMatchObject({ idle: true, reason: 'idle' }) // no profile asked: unchanged
    expect(classifyBrowserNode(p, 'w1', 'br-1', 'bp-a')).toMatchObject({ idle: true })
    expect(classifyBrowserNode(p, 'w1', 'br-1', 'bp-b')).toMatchObject({ idle: false, reason: 'other_profile' })
  })
  it('fails closed: asking for a profile with no way to tell the node\'s profile never reuses', () => {
    const p = { ...ports({}), profileOf: undefined }
    expect(classifyBrowserNode(p, 'w1', 'br-1', 'bp-a')).toMatchObject({ idle: false, reason: 'other_profile' })
  })
})
