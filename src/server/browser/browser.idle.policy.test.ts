import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
/** Every site that used to decide "idle" on its own; they must now only call the shared classifier. */
const SITES = [
  '../central/tools/defs/browser.read.ts',
  '../central/tools/defs/browser.status.ts',
  '../central/agents/agentReuse.ports.ts',
  '../central/agents/agentTidy.ts',
]
const OWN_RULES = [/cabledNodes/, /lease\s*[!=]==\s*'(human|agent)'/, /linkedPeerIds/, /startsWith\(\s*'br-'/, /BROWSER_PREFIX/]

describe('policy: one source of truth for "idle browser"', () => {
  it.each(SITES)('%s calls the shared classifier and holds no idle rule of its own', (rel) => {
    const src = read(rel)
    expect(src).toMatch(/classifyBrowserNode|idlePortsOf/)
    for (const rule of OWN_RULES) expect(src, `${rel} matches ${rule}`).not.toMatch(rule)
  })
  it('browser.idle.ts is where the Central browser id prefix rule lives', () => {
    expect(read('./browser.idle.ts')).toMatch(/CENTRAL_BROWSER_PREFIX = 'br-'/)
  })
})
