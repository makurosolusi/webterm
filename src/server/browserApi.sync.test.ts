import { describe, expect, it } from 'vitest'
import { BrowserError } from './browser/browserHost.targets'
import { syncRoute } from './browserApi.sync'
import type { SyncApiDeps } from './browserApi.sync'

const state = new Map<string, boolean>([['n1', false]])
const deps: SyncApiDeps = {
  get: (id) => state.get(id) ?? null,
  set: (id, on) => {
    if (!state.has(id)) throw new BrowserError('not_found', 'x')
    if (on && id === 'n1' && !state.get('split')) throw new BrowserError('bad_request', `node ${id}: Sync needs a split layout`)
    state.set(id, on)
    return on
  },
}
const json = (v: unknown) => async () => JSON.stringify(v)
const none = async () => ''

describe('sync api', () => {
  it('reads the state, 404s an unknown node', async () => {
    expect(await syncRoute('GET', 'n1', none, deps)).toEqual({ status: 200, body: { on: false } })
    expect((await syncRoute('GET', 'zz', none, deps)).status).toBe(404)
  })
  it('switches on a split node, refuses a node without a split with the reason', async () => {
    const refused = await syncRoute('POST', 'n1', json({ on: true }), deps)
    expect(refused).toMatchObject({ status: 400, body: { error: 'bad_request', message: expect.stringContaining('split') } })
    state.set('split', true)
    expect(await syncRoute('POST', 'n1', json({ on: true }), deps)).toEqual({ status: 200, body: { on: true } })
    expect(await syncRoute('POST', 'n1', json({ on: false }), deps)).toEqual({ status: 200, body: { on: false } })
  })
  it('validates ids, methods and body', async () => {
    expect((await syncRoute('POST', '../x', json({ on: true }), deps)).status).toBe(400)
    expect((await syncRoute('DELETE', 'n1', none, deps)).status).toBe(405)
    expect((await syncRoute('POST', 'n1', json({ on: 'yes' }), deps)).status).toBe(400)
    expect((await syncRoute('POST', 'n1', async () => '{bad', deps)).status).toBe(400)
  })
})
