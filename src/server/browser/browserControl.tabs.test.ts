// The control route for the tab verbs: capability mapping (`tabs` = browser.read, `tab` = browser.act), the wire shape of
// a tab refusal (code + status + next step) and that a plain browser.read capability may list but not open tabs.
import { describe, expect, it } from 'vitest'
import { BROWSER_VERB_CAP } from '../../shared/browser.contract'
import { CapabilityStore, allows } from '../control/capabilities'
import { AgentTabError } from './browser.agentTabs.verbs'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { handleBrowserControl } from './browserControl.handler'

const store = new CapabilityStore()
const verbs = {
  tabs: async () => ({ tabs: [], agentTab: null, max: 8 }),
  tab: async () => { throw new AgentTabError('tab_limit', 409, 'node n1: Tab limit (8) reached', 'close a tab first (tab close <id>), or work in another browser node') },
  click: async () => { throw new AgentTabError('stale_tab_ref', 409, 'node n1: stale', 'snapshot tab t2 first, then use the refs and snapId it returns') },
} as unknown as AgentVerbs

const call = (verb: string, cap: 'browser.read' | 'browser.act', body: unknown = {}) => handleBrowserControl(
  { method: 'POST', path: `/api/control/browser/n1/${verb}`, headers: { 'x-webterm-capability': store.mint({ verb: cap, resource: 'node:n1', ttlMs: 30_000 }) }, body },
  { capabilities: { verify: (t) => store.verify(t), allows: (r, v, res) => allows(r, v, res) }, verbs, agentAllowed: () => true, policy: () => null },
)

describe('tab verbs on the control route', () => {
  it('tabs is a browser.read verb, tab a browser.act verb', () => {
    expect(BROWSER_VERB_CAP.tabs).toBe('browser.read')
    expect(BROWSER_VERB_CAP.tab).toBe('browser.act')
  })

  it('a read capability may list tabs but not open or close them', async () => {
    expect(await call('tabs', 'browser.read')).toMatchObject({ status: 200, body: { ok: true, data: { max: 8 } } })
    expect(await call('tab', 'browser.read', { action: 'new' })).toMatchObject({ status: 403, body: { error: 'forbidden' } })
  })

  it('a tab refusal keeps its own code, status and next step on the wire', async () => {
    expect(await call('tab', 'browser.act', { action: 'new' })).toMatchObject({
      status: 409, body: { error: 'tab_limit', message: expect.stringContaining('Tab limit (8)'), next: expect.stringContaining('close a tab first') },
    })
    expect(await call('click', 'browser.act', { ref: 'e1', snapId: 's1' })).toMatchObject({
      status: 409, body: { error: 'stale_tab_ref', next: expect.stringContaining('snapshot tab t2 first') },
    })
  })
})
