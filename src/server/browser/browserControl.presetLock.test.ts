import { afterEach, describe, expect, it } from 'vitest'
import { TOKEN_HEADER } from '../auth'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import type { Workspace } from '../../shared/workspace'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { handleBrowserControl } from './browserControl.handler'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import { isPublicWebUrl } from './browser.publicUrl'

const board: Workspace = {
  id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  bridges: [{ id: 'l1', source: 'author', target: 'b1', kind: 'context' }, { id: 'l2', source: 'plain', target: 'b1', kind: 'context' }],
  nodes: [
    { id: 'author', kind: 'agentChat', preset: 'skill-author', x: 0, y: 0 }, { id: 'plain', kind: 'agentChat', x: 0, y: 0 },
    { id: 'b1', kind: 'browser', x: 0, y: 0 },
  ],
}
const calls: string[] = []
afterEach(() => { forgetNodeToken('author'); forgetNodeToken('plain'); calls.length = 0 })

const run = (who: string, verb: string, body: unknown = {}, node?: string) => {
  const verbs = new Proxy({} as AgentVerbs, { get: (_t, v: string) => async () => { calls.push(v); return { ok: true } } })
  return handleBrowserControl(
    { method: 'POST', path: `/api/control/browser/${node ? `${node}/` : ''}${verb}`, headers: { [TOKEN_HEADER]: nodeToken(who) }, body },
    {
      capabilities: { verify: () => undefined, allows: () => false }, verbs, agentAllowed: () => true,
      linked: (r, w) => resolveLinkedBrowser([board], r, w),
      presetOf: (id) => board.nodes.find((n) => n.id === id)?.preset,
    },
  )
}

describe('skill-author browser lock (server side, from the stored preset)', () => {
  it.each(['tabs', 'tab'])('403 verb_not_allowed_for_preset for the tab verb %s (a locked preset has one page)', async (verb) => {
    expect(await run('author', verb, { action: 'new', url: 'https://example.com/' })).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(calls).toEqual([])
  })

  it('403 when an allowed verb carries `tab`; the same call without it passes', async () => {
    expect(await run('author', 'snapshot', { tab: 't2' })).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(await run('author', 'navigate', { url: 'https://example.com/', tab: 't2' })).toMatchObject({ status: 403 })
    expect(calls).toEqual([])
    expect(await run('author', 'snapshot', {})).toMatchObject({ status: 200 })
  })

  it.each(['layout', 'arrange', 'sync', 'reload', 'back', 'forward'])('403 verb_not_allowed_for_preset for the layout verb %s', async (verb) => {
    expect(await run('author', verb, { spec: 'h t1 t2', on: true })).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(calls).toEqual([])
  })

  it('403 when an allowed verb asks for every tab (--all / --layout)', async () => {
    expect(await run('author', 'navigate', { url: 'https://example.com/', all: true })).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(await run('author', 'snapshot', { all: true })).toMatchObject({ status: 403 })
    expect(await run('author', 'screenshot', { layout: true })).toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  it('a node without a preset may use the tab verbs', async () => {
    expect(await run('plain', 'tabs', {})).toMatchObject({ status: 200 })
    expect(await run('plain', 'tab', { action: 'new' })).toMatchObject({ status: 200 })
    for (const verb of ['layout', 'arrange', 'sync', 'reload']) expect(await run('plain', verb, { spec: 'h t1 t2', on: true })).toMatchObject({ status: 200 })
  })

  it.each(['click', 'type', 'press', 'scroll', 'screenshot', 'console', 'wait', 'status', 'handoff', 'release'])('403 verb_not_allowed_for_preset for %s', async (verb) => {
    expect(await run('author', verb, { ref: 'e1', snapId: 's', text: 'x', key: 'a', dy: 1 })).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(calls).toEqual([])
  })

  it.each(['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'about:blank', 'chrome://settings', 'http://localhost:8700/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://2130706433/', 'http://[::1]/', 'https://user:pw@example.com/', 42])('403 url_not_public for %s', async (url) => {
    expect(await run('author', 'navigate', { url })).toMatchObject({ status: 403, body: { error: 'url_not_public' } })
    expect(await run('author', 'open', { url })).toMatchObject({ status: 403, body: { error: 'url_not_public' } })
    expect(calls).toEqual([])
  })

  it('403 when it names a browser node of its own choosing', async () => {
    expect(await run('author', 'snapshot', {}, 'b1')).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
  })

  it('whitelisted verbs on a public URL pass the lock', async () => {
    expect(await run('author', 'snapshot')).toMatchObject({ status: 200 })
    expect(await run('author', 'navigate', { url: 'https://bulma.io/documentation/' })).toMatchObject({ status: 200 })
    expect(calls).toEqual(['snapshot', 'navigate'])
    // no `open` deps in this harness: reaching 503 proves the lock let a public `open` through
    expect(await run('author', 'open', { url: 'https://bulma.io' })).toMatchObject({ status: 503, body: { error: 'open_unavailable' } })
  })

  it('a node without a preset is unchanged', async () => {
    expect(await run('plain', 'click', { ref: 'e1', snapId: 's' })).toMatchObject({ status: 200 })
    expect(await run('plain', 'navigate', { url: 'http://127.0.0.1:3000/' })).toMatchObject({ status: 200 })
    expect(await run('plain', 'snapshot', {}, 'b1')).toMatchObject({ status: 200 })
  })
})

describe('skill-author cannot use browser profiles (server side)', () => {
  it('403 profile_not_allowed_for_preset for open and navigate that name a profile, whatever the URL', async () => {
    for (const verb of ['open', 'navigate']) {
      expect(await run('author', verb, { url: 'https://bulma.io', profile: 'work' })).toMatchObject({ status: 403, body: { error: 'profile_not_allowed_for_preset' } })
    }
    expect(calls).toEqual([])
  })

  it('403 on the `profiles` listing verb; a plain node gets past the lock to the unavailable-profiles answer', async () => {
    const list = (who: string) => handleBrowserControl(
      { method: 'GET', path: '/api/control/browser/profiles', headers: { [TOKEN_HEADER]: nodeToken(who) }, body: undefined },
      { capabilities: { verify: () => undefined, allows: () => false }, verbs: {} as AgentVerbs, agentAllowed: () => true, linked: (r, w) => resolveLinkedBrowser([board], r, w), presetOf: (id) => board.nodes.find((n) => n.id === id)?.preset },
    )
    expect(await list('author')).toMatchObject({ status: 403, body: { error: 'verb_not_allowed_for_preset' } })
    expect(await list('plain')).toMatchObject({ status: 503, body: { error: 'open_unavailable' } })
  })
})

describe('isPublicWebUrl', () => {
  it('accepts public http(s) and rejects everything else', () => {
    expect(isPublicWebUrl('https://example.com/a?b=1')).toBe(true)
    expect(isPublicWebUrl('http://93.184.216.34/')).toBe(true)
    for (const u of ['ftp://example.com', 'http://localhost', 'http://foo.localhost/', 'http://192.168.1.1', 'http://172.16.0.1', 'http://100.64.0.1', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'not a url', '']) expect(isPublicWebUrl(u)).toBe(false)
  })
})
