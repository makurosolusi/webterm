import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import type { CapabilityId } from '../../shared/featureCapabilities'
import { reconcile } from '../featureCapabilities.runtime'
import { activeCa2, bootCa2, ca2Active, setActiveCa2 } from './ca2Boot'
import { freshDb } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { registerCa2Tools, toolsHash } from './tools/registerAll'
import { createRegistry } from './tools/toolRegistry'
import { defEnabled } from './tools/toolTypes'
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

describe('central off (dormant)', () => {
  it('merakit handle dormant: tanpa tool baru, hash sama, tidak jadi activeCa2', () => {
    const registry = coreRegistry()
    const before = toolsHash(registry)
    expect(ca2Active({})).toBe(false)
    const handle = bootCa2({ runtime: runtime(), sessions, env: {}, registry })
    expect(handle).not.toBeNull()
    expect(activeCa2()).toBeNull()
    expect(registerCa2Tools(registry, {}, {})).toEqual([])
    expect(registry.list().map((d) => d.name).sort()).toEqual(CORE_DEFS.map((d) => d.name).sort())
    expect(toolsHash(registry)).toBe(before)
    handle?.stop()
  })

  it('anak CA2 tanpa Central diabaikan (tidak aktif, tidak ada tool)', () => {
    const registry = coreRegistry()
    const env = { WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_CENTRAL_MEMORY: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on', WEBTERM_CENTRAL_SKILLS: 'on' }
    expect(ca2Active(env)).toBe(false)
    const handle = bootCa2({ runtime: runtime(), sessions, env, registry, dataDirPath: tmp(), noTimer: true })
    expect(handle?.toolNames).toEqual([])
    expect(handle?.executor).toBeNull()
    expect(activeCa2()).toBeNull()
    handle?.stop()
  })

  it('tanpa ledger: null walau Central on', () => {
    expect(bootCa2({ runtime: null, sessions, env: { WEBTERM_CENTRAL: 'on' }, registry: coreRegistry() })).toBeNull()
  })
})

describe('hot on/off tanpa rebuild', () => {
  it('Central dinyalakan lewat reconcile: tool baca terdaftar, handle aktif; dipadamkan: handle dilepas; ulang aman', async () => {
    const registry = coreRegistry()
    const env: Record<string, string | undefined> = {}
    const handle = bootCa2({ runtime: runtime(), sessions, env, registry, dataDirPath: tmp(), noTimer: true })
    expect(activeCa2()).toBeNull()
    env.WEBTERM_CENTRAL = 'on'
    await reconcile(new Set(), new Set<CapabilityId>(['central']))
    expect(activeCa2()).toBe(handle)
    const names = handle?.toolNames.slice() ?? []
    expect(names.length).toBeGreaterThan(0)
    await reconcile(new Set(), new Set<CapabilityId>(['central'])) // start dua kali: satu perakitan
    expect(handle?.toolNames).toEqual(names)
    env.WEBTERM_CENTRAL = 'off'
    await reconcile(new Set<CapabilityId>(['central']), new Set())
    expect(activeCa2()).toBeNull()
    await reconcile(new Set<CapabilityId>(['central']), new Set()) // stop dua kali aman
    env.WEBTERM_CENTRAL = 'on'
    await reconcile(new Set(), new Set<CapabilityId>(['central']))
    expect(activeCa2()).toBe(handle)
    expect(handle?.toolNames).toEqual(names)
    handle?.stop()
    await reconcile(new Set<CapabilityId>(['central']), new Set())
    await reconcile(new Set(), new Set<CapabilityId>(['central'])) // hook sudah dicabut: tak lagi mengaktifkan
    expect(activeCa2()).toBeNull()
  })
})

describe('flags on', () => {
  it('read tools flag registers the read defs and changes the hash; order of registration does not', () => {
    const a = coreRegistry()
    const added = registerCa2Tools(a, {}, { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on' })
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((n) => a.get(n))).toBe(true)
    expect(toolsHash(a)).not.toBe(toolsHash(coreRegistry()))
    const b = createRegistry()
    for (const def of [...a.list()].reverse()) b.register(def)
    expect(toolsHash(b)).toBe(toolsHash(a))
    // registering again adds nothing (idempotent)
    expect(registerCa2Tools(a, {}, { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on' })).toEqual([])
  })

  it('memory flag registers the memory, state and reminder defs and the shared blackboard (F5-b) only', () => {
    const r = coreRegistry()
    const added = registerCa2Tools(r, {}, { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_MEMORY: 'on' })
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((n) => n.startsWith('memory.') || n.startsWith('blackboard.') || n.startsWith('state.') || n.startsWith('reminder.'))).toBe(true)
    expect(added.filter((n) => n.startsWith('blackboard.'))).toEqual(['blackboard.read', 'blackboard.propose'])
    expect(added.filter((n) => n.startsWith('reminder.'))).toEqual(['reminder.set', 'reminder.list', 'reminder.cancel'])
  })

  it('agents/relay groups need their executor and mode', () => {
    const r = coreRegistry()
    expect(registerCa2Tools(r, {}, { WEBTERM_CENTRAL_AGENTS: 'propose', WEBTERM_AGENT_MAIL: 'on' }).some((n) => n.startsWith('agent.spawn'))).toBe(false)
  })

  it('boots with skills (memory + read tools ikut Central): handle, builtin skills installed, tools listed', () => {
    const registry = coreRegistry()
    const handle = bootCa2({
      runtime: runtime(), sessions, registry, noTimer: true, dataDirPath: tmp(),
      env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_SKILLS: 'on' },
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
    const handle = bootCa2({ runtime: runtime(), sessions, registry: coreRegistry(), noTimer: true, dataDirPath: tmp(), env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose' } })
    expect(handle?.executor).not.toBeNull()
    expect(handle?.toolNames.some((n) => n.startsWith('agent.'))).toBe(true)
    await handle?.ready
    expect(await handle?.sweep()).toBe(0)
  })
})

describe('read tools', () => {
  it('are registered once the flag is on, and not before', () => {
    const registry = defaultRegistry()
    const env = { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_READ_TOOLS: 'on' }
    const before = registry.list().length
    registerCa2Tools(registry, {}, env)
    const added = registry.list().filter((d) => d.tier === 'R0' && defEnabled(d, env) && !CORE_DEFS.some((c) => c.name === d.name))
    expect(registry.list().length).toBeGreaterThan(before)
    expect(added.length).toBeGreaterThan(0)
  })
})
