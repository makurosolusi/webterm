// Drift test (Orca handler-group-manifest.test.ts pattern): every capability is well formed and shows up
// in every projection that exists today (Central catalog, control HTTP router), and no verb or route
// list lives outside the registry.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { BROWSER_CONTROL_PREFIX, BROWSER_VERB_CAP } from '../../shared/browser.contract'
import { createCapabilityIndex } from './capability.define'
import { isObjectSchema } from './capability.schema'
import { CONTROL_CAPABILITIES } from './control.capabilities'
import { CAPABILITY_VERBS } from '../control/capabilities'
import { handleControl } from '../control/controlApi'
import { APPROVAL_ROUTES, handleApproval } from '../control/approvalApi'
import { handleBrowserControl } from '../browser/browserControl.handler'
import { harness } from '../control/fakeControlDeps'
import { AGENTS_FLAG } from '../central/tools/defs/agent.defs'
import { AGENT_MAIL_FLAG } from '../central/tools/defs/agent.relay.def'
import { BROWSER_TOOLS_FLAG } from '../central/tools/defs/browser.act'
import { KNOWLEDGE_FLAG } from '../central/tools/defs/kb.defs'
import { SKILLS_FLAG } from '../central/tools/defs/skill.defs'
import { CENTRAL_BOTS_FLAG } from '../channels/botManager'
import { createAgentKindsDef } from '../central/tools/defs/agentKinds.defs'
import { CORE_DEFS } from '../central/tools/defs/core.defs'
import { registerCa2Tools } from '../central/tools/registerAll'
import { toolCapability, toolProblems } from '../central/tools/toolCapability'
import { createRegistry } from '../central/tools/toolRegistry'
import type { ToolDef } from '../central/tools/toolTypes'

const stub = {} as never // test-only: builders capture deps, they never call them at registration

/** Every Central tool group switched on, with its per-def flags. */
function fullCentralRegistry() {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  const env: Record<string, string> = {
    WEBTERM_CENTRAL: 'on', [AGENTS_FLAG]: 'auto', [AGENT_MAIL_FLAG]: 'on', [KNOWLEDGE_FLAG]: 'on',
    [SKILLS_FLAG]: 'on', [CENTRAL_BOTS_FLAG]: 'on', [BROWSER_TOOLS_FLAG]: 'on',
  }
  const deps = { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: stub }
  // Per-def flags are only known once the defs exist: one dry pass collects them, the real pass registers.
  const dry = createRegistry()
  registerCa2Tools(dry, deps, new Proxy(env, { get: (t, k: string) => t[k] ?? 'on' }))
  for (const def of dry.list()) if (def.flag) env[def.flag] = 'on'
  registerCa2Tools(registry, deps, env)
  registry.register(createAgentKindsDef(stub)) // ca2Boot registers it once the agent catalog is built
  return { registry, env }
}

describe('capability declarations', () => {
  const { registry } = fullCentralRegistry()
  const defs: ToolDef[] = registry.list()

  it('registers every Central tool group (sanity: the full set is large)', () => {
    expect(defs.length).toBeGreaterThan(29)
    expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining(['cap.search', 'cap.describe', 'agent.spawn', 'kb.search', 'browser_act', 'task.run']))
  })

  for (const def of defs) it(`${def.name} declares summary, tier, input and output schema`, () => {
    expect(def.input).toBeDefined()
    expect(def.output).toBeDefined()
    expect(toolProblems(def)).toEqual([])
  })

  for (const cap of CONTROL_CAPABILITIES) it(`${cap.name} (control) declares schema, tier and route`, () => {
    expect(isObjectSchema(cap.input) && isObjectSchema(cap.output)).toBe(true)
    expect(cap.route?.path.startsWith('/api/control')).toBe(true)
  })

  it('one index over both surfaces: shared names agree on tier and scope', () => {
    const index = createCapabilityIndex([...defs.map(toolCapability), ...CONTROL_CAPABILITIES])
    expect(index.get('approval.request')?.projections).toEqual(expect.arrayContaining(['central', 'control-http']))
    expect(index.list().length).toBe(new Set([...defs.map((d) => d.name), ...CONTROL_CAPABILITIES.map((c) => c.name)]).size)
  })
})

describe('projection: control HTTP', () => {
  const { deps } = harness()
  const browserDeps = { capabilities: deps.capabilities, verbs: stub, agentAllowed: () => true }

  it('CAPABILITY_VERBS is exactly the control capability list', () => {
    expect([...CAPABILITY_VERBS]).toEqual(CONTROL_CAPABILITIES.map((c) => c.name))
  })

  for (const cap of CONTROL_CAPABILITIES) it(`${cap.name} route resolves in the real router`, async () => {
    const { method, path } = cap.route!
    const req = (p: string) => ({ method, path: p, headers: {}, body: {} })
    let results
    if (path.startsWith(BROWSER_CONTROL_PREFIX)) {
      const verbs = (cap.input.properties?.verb?.enum ?? []) as string[]
      results = await Promise.all(verbs.map((v) => handleBrowserControl(req(path.replace(':nodeId', 'n1').replace(':verb', v)), browserDeps)))
    } else if (path.includes('/approval/')) {
      results = [await handleApproval(req(path), { capabilities: deps.capabilities, approval: stub })]
    } else {
      results = [await handleControl(req(path), deps)]
    }
    for (const res of results) {
      expect(res).not.toBeNull()
      expect((res?.body as { error?: string } | undefined)?.error).not.toBe('not_found')
    }
  })

  it('browser verbs map 1:1 onto browser.read / browser.act', () => {
    const fromCaps = CONTROL_CAPABILITIES.filter((c) => c.name.startsWith('browser.'))
      .flatMap((c) => ((c.input.properties?.verb?.enum ?? []) as string[]).map((v) => [v, c.name]))
    expect(Object.fromEntries(fromCaps)).toEqual(BROWSER_VERB_CAP)
  })

  it('every route in the control routers is a registered capability (no list outside the registry)', () => {
    const src = readFileSync(join(__dirname, '../control/controlApi.ts'), 'utf8')
    const routed = [...src.matchAll(/method === '(GET|POST)' && path === `\$\{CONTROL_PREFIX\}(\/[a-z/]+)`/g)].map((m) => `${m[1]} /api/control${m[2]}`)
    const approval = Object.values(APPROVAL_ROUTES).map((p) => p)
    const declared = new Set(CONTROL_CAPABILITIES.map((c) => `${c.route!.method} ${c.route!.path}`))
    // `/token` is the root-only mint endpoint, not a capability verb.
    expect(routed.filter((r) => !r.endsWith('/token')).filter((r) => !declared.has(r))).toEqual([])
    expect(routed.length).toBeGreaterThan(5)
    for (const path of approval) expect([...declared].some((d) => d.endsWith(` ${path}`))).toBe(true)
  })
})
