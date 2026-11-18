// `downloads` through the control handler: the browser (so the profile folder) is the one the cable names at call time, and
// `copy` writes only under the working directory the SERVER knows for the caller, whatever the request body says.
import { afterEach, describe, expect, it } from 'vitest'
import { TOKEN_HEADER } from '../auth'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import type { Workspace } from '../../shared/workspace'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { handleBrowserControl } from './browserControl.handler'
import { resolveLinkedBrowser } from './browser.linkedTarget'

const board: Workspace = {
  id: 'w1', name: 'w', cwd: '/board/cwd', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  bridges: [{ id: 'l1', source: 'a1', target: 'bX', kind: 'context' }, { id: 'l2', source: 'a2', target: 'bY', kind: 'context' }],
  nodes: [
    { id: 'a1', kind: 'agentChat', cwd: '/work/a1', x: 0, y: 0 }, { id: 'a2', kind: 'agentChat', x: 0, y: 0 },
    { id: 'bX', kind: 'browser', x: 0, y: 0 }, { id: 'bY', kind: 'browser', x: 0, y: 0 },
  ],
}
const calls: Array<{ node: string; body: Record<string, unknown> }> = []
afterEach(() => { forgetNodeToken('a1'); forgetNodeToken('a2'); calls.length = 0 })

const cwdOf = (id: string) => board.nodes.find((n) => n.id === id)?.cwd ?? board.cwd
const verbs = new Proxy({} as AgentVerbs, { get: () => async (node: string, body: Record<string, unknown>) => { calls.push({ node, body }); return { ok: true } } })
const run = (who: string, body: unknown, node?: string) => handleBrowserControl(
  { method: 'POST', path: `/api/control/browser/${node ? `${node}/` : ''}downloads`, headers: { [TOKEN_HEADER]: nodeToken(who) }, body },
  { capabilities: { verify: () => undefined, allows: () => false }, verbs, agentAllowed: () => true, linked: (r, w) => resolveLinkedBrowser([board], r, w), cwdOf },
)

describe('downloads over the control handler', () => {
  it('goes to the browser the caller is cabled to, never to another one, even when it names it', async () => {
    expect(await run('a1', {})).toMatchObject({ status: 200 })
    expect(await run('a2', {})).toMatchObject({ status: 200 })
    expect(calls.map((c) => c.node)).toEqual(['bX', 'bY'])
    expect(await run('a1', { read: 'any' }, 'bY')).toMatchObject({ status: 403, body: { error: 'not_linked' } })
    expect(await run('a2', { copy: 'any', to: 'x' }, 'bX')).toMatchObject({ status: 403, body: { error: 'not_linked' } })
    expect(calls).toHaveLength(2)
  })

  it('removing the cable revokes it at once (the lookup is per call)', async () => {
    expect(await run('a1', { read: 'x' })).toMatchObject({ status: 200 })
    board.bridges = board.bridges.filter((b) => b.id !== 'l1')
    try {
      expect(await run('a1', { read: 'x' })).toMatchObject({ status: 404, body: { error: 'no_linked_browser' } })
    } finally {
      board.bridges.push({ id: 'l1', source: 'a1', target: 'bX', kind: 'context' })
    }
  })

  it('the working directory comes from the server (node cwd, else its board), overwriting whatever the caller sent', async () => {
    await run('a1', { copy: 'x', to: 'f.txt', cwd: '/etc' })
    await run('a2', { copy: 'x', to: 'f.txt', cwd: '/etc' })
    expect(calls.map((c) => c.body.cwd)).toEqual(['/work/a1', '/board/cwd'])
  })

  it('a handler without a cwd source offers no working directory at all', async () => {
    const r = await handleBrowserControl(
      { method: 'POST', path: '/api/control/browser/downloads', headers: { [TOKEN_HEADER]: nodeToken('a1') }, body: { copy: 'x', to: 'f', cwd: '/etc' } },
      { capabilities: { verify: () => undefined, allows: () => false }, verbs, agentAllowed: () => true, linked: (r2, w) => resolveLinkedBrowser([board], r2, w) },
    )
    expect(r).toMatchObject({ status: 200 })
    expect(calls[0].body.cwd).toBeUndefined()
  })
})
