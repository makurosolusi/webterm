import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { activeCa2, bootCa2, ca2Active, setActiveCa2 } from './ca2Boot'
import { freshDb } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { registerCa2Tools, toolsHash } from './tools/registerAll'
import { createRegistry } from './tools/toolRegistry'
import { activeTools, renderCatalog } from './tools/toolRegistry'
import { centralStaticPrompt } from './proposal/centralPrompt'
import { defaultRegistry } from './tools/defaultRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ca2-boot-')); dirs.push(d); return d }
const coreRegistry = () => { const r = createRegistry(); for (const d of CORE_DEFS) r.register(d); return r }
const runtime = (): LedgerRuntime => ({ db: freshDb() }) as unknown as LedgerRuntime
afterEach(() => {
  setActiveCa2(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('all flags off', () => {
  it('does not arm CA2: no handle, no new tools, identical toolsHash', () => {
    const registry = coreRegistry()
    const before = toolsHash(registry)
    expect(ca2Active({})).toBe(false)
    expect(bootCa2({ runtime: runtime(), sessions, env: {}, registry })).toBeNull()
    expect(activeCa2()).toBeNull()
    expect(registerCa2Tools(registry, {}, {})).toEqual([])
    expect(registry.list().map((d) => d.name).sort()).toEqual(CORE_DEFS.map((d) => d.name).sort())
    expect(toolsHash(registry)).toBe(before)
  })

  it('treats explicit off/garbage values as off', () => {
    expect(ca2Active({ WEBTERM_CENTRAL_AGENTS: 'off', WEBTERM_CENTRAL_MEMORY: 'nope', WEBTERM_CENTRAL_READ_TOOLS: '0' })).toBe(false)
  })

  it('does not boot without a ledger even when flags are on', () => {
    expect(bootCa2({ runtime: null, sessions, env: { WEBTERM_CENTRAL_MEMORY: 'on' }, registry: coreRegistry() })).toBeNull()
  })
})

describe('flags on', () => {
  it('read tools flag registers the read defs and changes the hash; order of registration does not', () => {
    const a = coreRegistry()
    const added = registerCa2Tools(a, {}, { WEBTERM_CENTRAL_READ_TOOLS: 'on' })
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((n) => a.get(n))).toBe(true)
    expect(toolsHash(a)).not.toBe(toolsHash(coreRegistry()))
    const b = createRegistry()
    for (const def of [...a.list()].reverse()) b.register(def)
    expect(toolsHash(b)).toBe(toolsHash(a))
    // registering again adds nothing (idempotent)
    expect(registerCa2Tools(a, {}, { WEBTERM_CENTRAL_READ_TOOLS: 'on' })).toEqual([])
  })

  it('memory flag registers the memory defs only', () => {
    const r = coreRegistry()
    const added = registerCa2Tools(r, {}, { WEBTERM_CENTRAL_MEMORY: 'on' })
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((n) => n.startsWith('memory.'))).toBe(true)
  })

  it('agents/relay groups need their executor and mode', () => {
    const r = coreRegistry()
    expect(registerCa2Tools(r, {}, { WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_AGENT_MAIL: 'on' }).some((n) => n.startsWith('agent.spawn'))).toBe(false)
  })

  it('boots with skills + memory + read tools: handle, builtin skills installed, tools listed', () => {
    const registry = coreRegistry()
    const handle = bootCa2({
      runtime: runtime(), sessions, registry, noTimer: true, dataDirPath: tmp(),
      env: { WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_MEMORY: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on' },
    })
    expect(handle).not.toBeNull()
    expect(activeCa2()).toBe(handle)
    expect(handle?.executor).toBeNull()
    expect(handle?.skills?.list('active').length).toBeGreaterThan(0)
    expect(handle?.toolNames).toEqual(expect.arrayContaining(registry.list().map((d) => d.name).filter((n) => !CORE_DEFS.some((c) => c.name === n))))
    expect(handle?.toolsHash).toBe(toolsHash(registry))
    handle?.stop()
  })

  it('boot with the agents flag builds an executor under the injected data dir and sweeps nothing', async () => {
    const handle = bootCa2({ runtime: runtime(), sessions, registry: coreRegistry(), noTimer: true, dataDirPath: tmp(), env: { WEBTERM_CENTRAL_AGENTS: 'propose' } })
    expect(handle?.executor).not.toBeNull()
    expect(handle?.toolNames.some((n) => n.startsWith('agent.'))).toBe(true)
    await handle?.ready
    expect(await handle?.sweep()).toBe(0)
  })
})

describe('prompt catalog', () => {
  it('includes the read tools once registered and the flag is on, and not before', () => {
    const registry = defaultRegistry()
    const env = { WEBTERM_CENTRAL_READ_TOOLS: 'on' }
    const before = renderCatalog(registry, 'R0', env)
    registerCa2Tools(registry, {}, env)
    const names = activeTools(registry, 'R0', env).map((d) => d.name)
    const after = renderCatalog(registry, 'R0', env)
    expect(after.length).toBeGreaterThan(before.length)
    const readName = names.find((n) => !CORE_DEFS.some((c) => c.name === n))
    expect(readName).toBeDefined()
    expect(after).toContain(readName as string)
    expect(centralStaticPrompt()).toEqual(expect.any(String))
  })
})
