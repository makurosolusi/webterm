import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_CDP, callAllowed, isCdpAllowed } from './browserAgent.cdpAllowlist'

const DENIED = [
  'Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'Network.clearBrowserCookies', 'Storage.clearCookies',
  'Network.setCookie', 'Network.setCookies', 'Fetch.enable', 'Fetch.fulfillRequest', 'Browser.close', 'Browser.setDownloadBehavior',
  'Target.createTarget', 'Target.attachToTarget', 'Page.setDownloadBehavior', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Page.navigate', 'Input.dispatchMouseEvent', 'Emulation.setUserAgentOverride', 'DOM.setOuterHTML', 'DOM.getOuterHTML',
  'constructor.x', 'toString', '', '.', 'Page.', 'Page.__proto__', '__proto__.x',
]

describe('agent CDP allowlist', () => {
  it.each(DENIED)('denies %j without touching the host', async (method) => {
    const host = { cdp: vi.fn() }
    expect(isCdpAllowed(method, {})).toBe(false)
    await expect(callAllowed(host, 'n1', method, {})).rejects.toMatchObject({ code: 'blocked' })
    expect(host.cdp).not.toHaveBeenCalled()
  })

  it('allows the verb methods with valid params and forwards them', async () => {
    const host = { cdp: vi.fn(async () => ({ ok: 1 })) }
    await callAllowed(host, 'n1', AGENT_CDP.axTree, {})
    await callAllowed(host, 'n1', AGENT_CDP.focus, { backendNodeId: 5 })
    await callAllowed(host, 'n1', AGENT_CDP.screenshot, { format: 'jpeg', quality: 60 })
    expect(host.cdp).toHaveBeenCalledTimes(3)
  })

  it('validates parameters per method', () => {
    expect(isCdpAllowed(AGENT_CDP.focus, { backendNodeId: '5' })).toBe(false)
    expect(isCdpAllowed(AGENT_CDP.focus, { backendNodeId: 5, objectId: 'x' })).toBe(false)
    expect(isCdpAllowed(AGENT_CDP.axTree, { depth: 1 })).toBe(false)
    expect(isCdpAllowed(AGENT_CDP.screenshot, { format: 'png', quality: 60 })).toBe(false)
    expect(isCdpAllowed(AGENT_CDP.screenshot, { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: Infinity, height: 1, scale: 1 } })).toBe(false)
    expect(isCdpAllowed(AGENT_CDP.screenshot, { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } })).toBe(true)
  })

  it('every AGENT_CDP method is itself allowed', () => {
    for (const m of Object.values(AGENT_CDP)) {
      expect(isCdpAllowed(m, m.includes('DOM.') ? { backendNodeId: 1 } : m.endsWith('captureScreenshot') ? { format: 'jpeg', quality: 60 } : {})).toBe(true)
    }
  })
})

describe('agent code reaches CDP only through callAllowed', () => {
  it('no direct .cdp( / .send( outside the wrapper and the host layer', () => {
    const skip = (f: string) => f.endsWith('.test.ts') || f.endsWith('.testkit.ts') || f.startsWith('browserHost.') || f === 'cdp.client.ts' || f === 'browserAgent.cdpAllowlist.ts'
    const offenders = readdirSync(__dirname)
      .filter((f) => f.startsWith('browserAgent.') && f.endsWith('.ts') && !skip(f))
      .filter((f) => /\.(cdp|send)\(/.test(readFileSync(join(__dirname, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
