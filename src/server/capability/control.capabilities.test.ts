// browser.* declare their per-verb args, so MCP `tools/list` and `webterm agent-context` show agents
// what navigate/click/type/press/scroll/wait take instead of a bare `verb`.
import { describe, expect, it } from 'vitest'
import { checkSchema } from './capability.schema'
import { CONTROL_CAPABILITIES } from './control.capabilities'

const input = (name: string) => CONTROL_CAPABILITIES.find((c) => c.name === name)!.input!

describe('browser capability schemas', () => {
  it('browser.act lists the args of every act verb; only verb is required', () => {
    const s = input('browser.act')
    expect(Object.keys(s.properties ?? {})).toEqual(expect.arrayContaining(['nodeId', 'verb', 'url', 'ref', 'snapId', 'text', 'submit', 'key', 'dy']))
    expect(s.required).toEqual(['verb'])
    expect(checkSchema(s, { verb: 'navigate', url: 'https://example.com/' })).toBeNull()
    expect(checkSchema(s, { verb: 'type', ref: 'e12', snapId: 's1', text: 'hi', submit: true })).toBeNull()
    expect(checkSchema(s, { verb: 'click', ref: 'button', snapId: 's1' })).toBe('$.ref: pattern')
    expect(checkSchema(s, { verb: 'scroll', dy: '100' })).toBe('$.dy: type number')
  })

  it('browser.read lists screenshot/wait args', () => {
    const s = input('browser.read')
    expect(Object.keys(s.properties ?? {})).toEqual(expect.arrayContaining(['maxWidth', 'ms', 'selectorRef', 'loaded']))
    expect(checkSchema(s, { verb: 'wait', ms: 500, loaded: true })).toBeNull()
    expect(checkSchema(s, { verb: 'wait', loaded: false })).toBe('$.loaded: const')
  })
})
