import { describe, expect, it } from 'bun:test'
import { registerCa2Tools } from '../registerAll'
import { createRegistry, toolsHash } from '../toolRegistry'
import { BROWSER_ACT_FLAG, createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

const ENV_ON = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
const browser: BrowserToolDeps = { state: () => undefined, listDomains: () => [], control: async () => ({ status: 200 }) }

describe('browser tool registration', () => {
  it('flags off or deps missing: nothing registered and toolsHash equals the empty registry', () => {
    const empty = createRegistry()
    const r = createRegistry()
    expect(registerCa2Tools(r, { browser }, {})).toEqual([])
    expect(registerCa2Tools(r, { browser }, { [BROWSER_ACT_FLAG]: 'on' })).toEqual([])
    expect(registerCa2Tools(createRegistry(), {}, ENV_ON)).toEqual([])
    expect(toolsHash(r)).toBe(toolsHash(empty))
  })
  it('feature flag registers the status tool; agent flag adds act; toolsHash is stable and order-independent', () => {
    const a = createRegistry()
    expect(registerCa2Tools(a, { browser }, { [BROWSER_TOOLS_FLAG]: 'on' })).toEqual(['browser_status'])
    const b = createRegistry()
    expect(registerCa2Tools(b, { browser }, ENV_ON)).toEqual(['browser_status', 'browser_act'])
    const c = createRegistry()
    createBrowserDefs(browser).reverse().forEach((d) => c.register(d))
    expect(toolsHash(c)).toBe(toolsHash(b))
    expect(toolsHash(a)).not.toBe(toolsHash(b))
    expect(b.list().map((d) => [d.name, d.tier, d.summary.length <= 120])).toEqual([['browser_status', 'R0', true], ['browser_act', 'R2', true]])
  })
})
