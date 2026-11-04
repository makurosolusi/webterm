import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserState } from '../../shared/browser.contract'
import type { AgentVerbs } from '../browser/browserAgent.verbs.ctx'
import { handleBrowserControl } from '../browser/browserControl.handler'
import type { BrowserRuntime } from '../browser/browser.state'
import { CapabilityStore, allows } from '../control/capabilities'
import type { ControlRequest } from '../control/controlTypes'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { bootCa2, setActiveCa2 } from './ca2Boot'
import { registerWorkspaceLookup } from './workspaceLookup'
import { BROWSER_CAP_TTL_MS } from './ca2Boot.browser'
import { freshDb, rows, run } from './guard/controlGuard.testutil'
import { ALLOW_ALL_GUARD, execTool } from './tools/toolExec'
import { createRegistry } from './tools/toolRegistry'
import { CORE_DEFS } from './tools/defs/core.defs'
import type { ToolCtx } from './tools/toolTypes'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ca2-boot-br-')); dirs.push(d); return d }
let unregister = (): void => undefined
afterEach(() => {
  unregister()
  setActiveCa2(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BASE = { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on' }
const ON = { ...BASE, WEBTERM_BROWSER: 'on', WEBTERM_BROWSER_AGENT: 'on' }
const STATE: BrowserState = { id: 'b1', url: 'https://app.example.com/inbox?token=SECRET', title: 'Inbox', loading: false, canBack: false, canForward: false, lease: 'agent', live: 'live' }

function rig() {
  const store = new CapabilityStore()
  const seen: string[] = []
  const verbs = new Proxy({} as AgentVerbs, { get: () => async () => ({ ok: true }) })
  const runtime = {
    state: (id: string) => (id === 'b1' ? STATE : undefined),
    listDomains: () => [{ domain: 'app.example.com', count: 3, expiresAt: 9 }],
    control: (req: ControlRequest, capabilities: Parameters<typeof handleBrowserControl>[1]['capabilities']) => {
      seen.push(String(req.headers?.['x-webterm-capability']))
      return handleBrowserControl(req, { capabilities, verbs, agentAllowed: () => true })
    },
  } as unknown as BrowserRuntime
  return { store, seen, runtime }
}

function boot(env: Record<string, string>, active: () => BrowserRuntime | null) {
  const db = freshDb()
  // Workspaces come from the webterm.db store, not the ledger file (production layout).
  unregister = registerWorkspaceLookup((id) => (id === 'w1' ? { name: 'w1', nodes: [{ id: 'b1', kind: 'browser' }] } : null))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const r = rig()
  const handle = bootCa2({ runtime: { db } as unknown as LedgerRuntime, sessions, env, registry, dataDirPath: tmp(), noTimer: true, browser: { store: r.store, active } })
  const ctx: ToolCtx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env }
  return { db, registry, handle, ctx, ...r }
}

describe('browser tools boot wiring', () => {
  it('feature flag + agent flag register browser_status and browser_act', () => {
    const r = rig()
    const b = boot(ON, () => r.runtime)
    expect(b.handle?.toolNames).toEqual(expect.arrayContaining(['browser_status', 'browser_act']))
    expect(b.registry.get('browser_act')).toBeDefined()
  })

  it('feature flag alone registers browser_act too (agent flag default on, same reader as wired agents)', () => {
    const b = boot({ ...BASE, WEBTERM_BROWSER: 'on' }, () => null)
    expect(b.handle?.toolNames).toEqual(expect.arrayContaining(['browser_status', 'browser_act']))
  })

  it('explicit agent off registers only browser_status', () => {
    const b = boot({ ...BASE, WEBTERM_BROWSER: 'on', WEBTERM_BROWSER_AGENT: 'off' }, () => null)
    expect(b.handle?.toolNames).toContain('browser_status')
    expect(b.handle?.toolNames).not.toContain('browser_act')
  })

  it('flags off: no browser tools and toolsHash equals a boot without the browser wiring', () => {
    const off = boot(BASE, () => rig().runtime)
    expect(off.handle?.toolNames.some((n) => n.startsWith('browser_'))).toBe(false)
    expect(off.registry.get('browser_status')).toBe(undefined)
    const agentOnly = boot({ ...BASE, WEBTERM_BROWSER_AGENT: 'on' }, () => rig().runtime)
    expect(agentOnly.handle?.toolsHash).toBe(off.handle?.toolsHash)
  })

  it('browser_status reads the live runtime: host only, domain names only', async () => {
    const r = rig()
    const b = boot(ON, () => r.runtime)
    const res = await execTool(b.ctx, 'browser_status', { projectId: 'p1' })
    expect(res).toMatchObject({ ok: true })
    const text = JSON.stringify(res)
    expect(text).toContain('app.example.com')
    expect(text).not.toContain('SECRET')
  })

  it('browser_act goes through the control handler with a minted capability that never leaks and is revoked', async () => {
    const r = rig()
    const b = boot(ON, () => r.runtime)
    const res = await execTool(b.ctx, 'browser_act', { projectId: 'p1', nodeId: 'b1', action: 'navigate', url: 'https://app.example.com/' })
    expect(res).toMatchObject({ ok: true })
    expect(r.seen).toHaveLength(1)
    const token = r.seen[0]!
    expect(token.startsWith('wcap_')).toBe(true)
    expect(r.store.verify(token)).toBe(undefined) // revoked after the call
    const audit = JSON.stringify(rows(b.db, "SELECT payload_json FROM event WHERE kind = 'central.proposal'"))
    expect(JSON.stringify(res)).not.toContain(token)
    expect(audit).not.toContain(token)
    expect(BROWSER_CAP_TTL_MS <= 60_000).toBe(true)
  })

  it('runtime not started: browser_act fails closed with disabled, status shows unknown nodes', async () => {
    const b = boot(ON, () => null)
    expect(await execTool(b.ctx, 'browser_act', { projectId: 'p1', nodeId: 'b1', action: 'navigate', url: 'https://app.example.com/' })).toMatchObject({ ok: false, code: 'disabled' })
    expect(await execTool(b.ctx, 'browser_status', { projectId: 'p1' })).toMatchObject({ ok: true })
  })

  it('capability store scopes the token to the node', () => {
    const r = rig()
    const t = r.store.mint({ verb: 'browser.act', resource: 'node:b1', ttlMs: 1000 })
    const rec = r.store.verify(t)!
    expect(allows(rec, 'browser.act', 'node:b2')).toBe(false)
  })
})
