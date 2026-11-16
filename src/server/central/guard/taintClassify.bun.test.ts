// Bun-only. Policy lock: every registered tool above R0 is named in exactly one taint list, so a new tool cannot be unclassified.
import { expect, test } from 'bun:test'
import { CORE_DEFS } from '../tools/defs/core.defs'
import { registerCa2Tools } from '../tools/registerAll'
import { createRegistry } from '../tools/toolRegistry'
import { IMPACTFUL_TOOLS, isImpactful, SAFE_UNDER_TAINT } from './taintClassify'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const env = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })

test('policy: every registered R1+ tool is in exactly one of IMPACTFUL_TOOLS / SAFE_UNDER_TAINT, R0 is never impactful', () => {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: { open: stub, openProject: stub, reader: stub } as never }, env)
  const defs = registry.list()
  const names = defs.map((d) => d.name)
  const above = defs.filter((d) => d.tier !== 'R0')
  expect(above.filter((d) => !IMPACTFUL_TOOLS.includes(d.name) && !SAFE_UNDER_TAINT.includes(d.name)).map((d) => d.name)).toEqual([])
  expect(IMPACTFUL_TOOLS.filter((n) => SAFE_UNDER_TAINT.includes(n))).toEqual([])
  expect([...IMPACTFUL_TOOLS, ...SAFE_UNDER_TAINT].filter((n) => !names.includes(n))).toEqual([])
  expect(defs.filter((d) => d.tier === 'R0' && isImpactful(d.name, d.tier)).map((d) => d.name)).toEqual([])
  expect(above.filter((d) => isImpactful(d.name, d.tier) !== IMPACTFUL_TOOLS.includes(d.name)).map((d) => d.name)).toEqual([])
})

test('an unnamed tool above R0 is impactful by default, an unnamed R0 tool is safe', () => {
  expect(isImpactful('brand.new', 'R1')).toBe(true)
  expect(isImpactful('brand.new', 'R0')).toBe(false)
})
