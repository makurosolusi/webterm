import { describe, expect, it } from 'vitest'
import type { Workspace, WsNode } from '../../shared/workspace'
import { CapabilityStore, MAX_TTL_MS } from '../control/capabilities'
import { BROWSER_ACT_CAP_ENV, BROWSER_NODE_ID_ENV, BROWSER_READ_CAP_ENV } from '../browserAgentShim'
import { createBrowserSessionHook, pickBrowserNode } from './browser.sessionCaps'

const node = (id: string, kind: WsNode['kind']): WsNode => ({ id, kind, x: 0, y: 0 })
const ws = (nodes: WsNode[], bridges: Workspace['bridges'] = []): Workspace =>
  ({ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes, bridges, updatedAt: 0 })

describe('pickBrowserNode', () => {
  it('uses the sole browser node of the session workspace', () => {
    expect(pickBrowserNode([ws([node('a1', 'agent'), node('b1', 'browser')])], 'a1')).toBe('b1')
  })
  it('prefers the bridged browser node when there are several', () => {
    const w = ws([node('a1', 'agent'), node('b1', 'browser'), node('b2', 'browser')], [{ id: 'l', source: 'a1', target: 'b2', kind: 'context' }])
    expect(pickBrowserNode([w], 'a1')).toBe('b2')
  })
  it('is undefined when ambiguous, absent, or the session is unknown', () => {
    expect(pickBrowserNode([ws([node('a1', 'agent'), node('b1', 'browser'), node('b2', 'browser')])], 'a1')).toBeUndefined()
    expect(pickBrowserNode([ws([node('a1', 'agent')])], 'a1')).toBeUndefined()
    expect(pickBrowserNode([ws([node('b1', 'browser')])], 'ghost')).toBeUndefined()
  })
})

describe('createBrowserSessionHook', () => {
  const setup = (agentEnabled = true) => {
    const store = new CapabilityStore()
    const hook = createBrowserSessionHook({ store, agentEnabled: () => agentEnabled, workspaces: () => [ws([node('a1', 'agent'), node('b1', 'browser')])] })
    return { store, hook }
  }

  it('mints a read and an act capability scoped to the browser node and injects the env', () => {
    const { store, hook } = setup()
    const env = hook.envFor('a1', 'claude')
    expect(env[BROWSER_NODE_ID_ENV]).toBe('b1')
    const read = store.verify(env[BROWSER_READ_CAP_ENV])
    const act = store.verify(env[BROWSER_ACT_CAP_ENV])
    expect([read?.verb, act?.verb]).toEqual(['browser.read', 'browser.act'])
    expect([read?.resource, act?.resource]).toEqual(['node:b1', 'node:b1'])
    expect(read && read.expiresAt - Date.now()).toBeLessThanOrEqual(MAX_TTL_MS)
  })

  it('gives nothing to plain terminals, when the agent flag is off, or when no browser node resolves', () => {
    expect(setup().hook.envFor('a1', undefined)).toEqual({})
    expect(setup(false).hook.envFor('a1', 'claude')).toEqual({})
    expect(setup().hook.envFor('ghost', 'claude')).toEqual({})
  })

  it('release revokes both tokens; a respawn revokes the previous pair', () => {
    const { store, hook } = setup()
    const first = hook.envFor('a1', 'claude')
    const second = hook.envFor('a1', 'claude')
    expect(store.verify(first[BROWSER_READ_CAP_ENV])).toBeUndefined()
    expect(store.verify(second[BROWSER_ACT_CAP_ENV])).toBeDefined()
    hook.release('a1')
    expect(store.verify(second[BROWSER_READ_CAP_ENV])).toBeUndefined()
    expect(store.verify(second[BROWSER_ACT_CAP_ENV])).toBeUndefined()
  })
})
