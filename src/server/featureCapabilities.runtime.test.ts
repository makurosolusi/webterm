import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, closure, deriveFlags, type CapabilityId } from '../shared/featureCapabilities'

type Runtime = typeof import('./featureCapabilities.runtime')
type Legacy = typeof import('./featureCapabilities.legacy')
let rt: Runtime
let legacy: Legacy
let logBus: typeof import('./logs').logBus

// Modul baru per tes: registri hook dan set "sudah di-warn" adalah state modul.
beforeEach(async () => {
  vi.resetModules()
  ;({ logBus } = await import('./logs'))
  logBus.clear()
  rt = await import('./featureCapabilities.runtime')
  legacy = await import('./featureCapabilities.legacy')
})

const SUBSETS: Set<CapabilityId>[] = Array.from({ length: 1 << CAPABILITY_IDS.length }, (_, mask) =>
  new Set(CAPABILITY_IDS.filter((_id, i) => mask & (1 << i))))
const warns = (): string[] => logBus.query().filter((e) => e.event === 'capability.legacy_ignored').map((e) => String(e.data?.key))

describe('isEnabled/enabledSet', () => {
  it('env kosong -> semua off', () => {
    expect([...rt.enabledSet({})]).toEqual([])
    for (const id of CAPABILITY_IDS) expect(rt.isEnabled(id, {})).toBe(false)
  })

  it('dialek flag: on/1/true on; yes/kosong off', () => {
    for (const v of ['on', 'ON', '1', 'true', ' true ']) expect(rt.isEnabled('central', { WEBTERM_CENTRAL: v })).toBe(true)
    for (const v of ['yes', '', 'off', '2']) expect(rt.isEnabled('central', { WEBTERM_CENTRAL: v })).toBe(false)
  })

  it('anak on tanpa induk -> off (autonomy tanpa workers)', () => {
    expect(rt.isEnabled('autonomy', { WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_CENTRAL: 'on' })).toBe(false)
    expect(rt.isEnabled('autonomy', { WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' })).toBe(false)
    const full = { WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL: 'on' }
    expect(rt.isEnabled('autonomy', full)).toBe(true)
  })

  it('128 subset: enabledSet(deriveFlags(S)) = closure(S), tak pernah inkoheren', () => {
    for (const s of SUBSETS) {
      const got = rt.enabledSet(deriveFlags(s))
      expect(got).toEqual(new Set([...s].flatMap(closure)))
      for (const id of got) for (const dep of CAPABILITIES[id].implies) expect(got.has(dep)).toBe(true)
    }
  })

  it('default memakai process.env', () => {
    vi.stubEnv('WEBTERM_BROWSER', 'on')
    expect(rt.isEnabled('browser')).toBe(true)
    expect(rt.enabledSet().has('browser')).toBe(true)
    vi.unstubAllEnvs()
  })
})

describe('legacyToCapabilities', () => {
  it('store kosong -> kosong, tanpa warn', () => {
    expect(legacy.legacyToCapabilities({})).toEqual({ set: new Set(), ignored: [] })
    expect(warns()).toEqual([])
  })

  it('AUTONOMY=on tanpa ORCHESTRATOR_RUN -> autonomy off + ignored', () => {
    const r = legacy.legacyToCapabilities({ WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' })
    expect([...r.set]).toEqual(['central'])
    expect(r.ignored).toEqual(['WEBTERM_CENTRAL_AUTONOMY'])
  })

  it('rantai utuh -> semua masuk, urutan kunci tak berpengaruh', () => {
    const a = legacy.legacyToCapabilities({ WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL: 'on' })
    const b = legacy.legacyToCapabilities({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' })
    expect(a.set).toEqual(new Set(['central', 'workers', 'autonomy']))
    expect(b).toEqual(a)
    expect(a.ignored).toEqual([])
  })

  it('anak/sub tanpa induk aktif diabaikan; dengan induk tidak', () => {
    const orphan = legacy.legacyToCapabilities({
      WEBTERM_FILES_WATCH: 'on', WEBTERM_CENTRAL_CHAT: 'on', WEBTERM_RUN_REQUIRE_APPROVAL: 'on', WEBTERM_AGENT_MAIL: '1',
    })
    expect(orphan.set.size).toBe(0)
    expect(orphan.ignored.sort()).toEqual(
      ['WEBTERM_AGENT_MAIL', 'WEBTERM_CENTRAL_CHAT', 'WEBTERM_FILES_WATCH', 'WEBTERM_RUN_REQUIRE_APPROVAL'])
    const ok = legacy.legacyToCapabilities({ WEBTERM_FILES_VIEWERS: 'on', WEBTERM_FILES_WATCH: 'on' })
    expect(ok.ignored).toEqual([])
    // CENTRAL_TELEGRAM butuh central DAN telegram.
    expect(legacy.legacyToCapabilities({ WEBTERM_TELEGRAM: 'on', WEBTERM_CENTRAL_TELEGRAM: 'on' }).ignored)
      .toEqual(['WEBTERM_CENTRAL_TELEGRAM'])
  })

  it('anak bernilai off tanpa induk tidak dianggap diabaikan', () => {
    expect(legacy.legacyToCapabilities({ WEBTERM_FILES_WATCH: 'off' }).ignored).toEqual([])
  })

  it('warn tepat satu per kunci per proses, hanya nama kunci', () => {
    const env = { WEBTERM_CENTRAL_AUTONOMY: 'on', WEBTERM_FILES_WATCH: 'on', WEBTERM_TELEGRAM: 'on' }
    legacy.legacyToCapabilities(env)
    legacy.legacyToCapabilities(env)
    expect(warns().sort()).toEqual(['WEBTERM_CENTRAL_AUTONOMY', 'WEBTERM_FILES_WATCH'])
  })
})

describe('onCapabilityChange/reconcile', () => {
  const hook = (id: string, calls: string[]) => ({
    start: () => { calls.push(`start:${id}`) },
    stop: () => { calls.push(`stop:${id}`) },
  })
  const S = (...ids: CapabilityId[]): Set<CapabilityId> => new Set(ids)

  it('start dua kali aman (satu instans), stop dua kali aman', async () => {
    const calls: string[] = []
    rt.onCapabilityChange('browser', hook('b', calls))
    await rt.reconcile(S(), S('browser'))
    await rt.reconcile(S(), S('browser'))
    expect(calls).toEqual(['start:b'])
    await rt.reconcile(S('browser'), S())
    await rt.reconcile(S('browser'), S())
    expect(calls).toEqual(['start:b', 'stop:b'])
  })

  it('stop sebelum start aman; start-stop-start hidup satu instans', async () => {
    const calls: string[] = []
    rt.onCapabilityChange('browser', hook('b', calls))
    await rt.reconcile(S('browser'), S())
    expect(calls).toEqual([])
    await rt.reconcile(S(), S('browser'))
    await rt.reconcile(S('browser'), S())
    await rt.reconcile(S(), S('browser'))
    expect(calls).toEqual(['start:b', 'stop:b', 'start:b'])
  })

  it('urutan: stop dependents dulu, start prasyarat dulu', async () => {
    const calls: string[] = []
    for (const id of ['central', 'workers', 'autonomy'] as const) rt.onCapabilityChange(id, hook(id, calls))
    await rt.reconcile(S(), S('central', 'workers', 'autonomy'))
    expect(calls).toEqual(['start:central', 'start:workers', 'start:autonomy'])
    calls.length = 0
    await rt.reconcile(S('central', 'workers', 'autonomy'), S())
    expect(calls).toEqual(['stop:autonomy', 'stop:workers', 'stop:central'])
  })

  it('stop mendahului start dalam satu reconcile; id tak berubah tak disentuh', async () => {
    const calls: string[] = []
    for (const id of ['browser', 'files', 'telegram'] as const) rt.onCapabilityChange(id, hook(id, calls))
    await rt.reconcile(S(), S('files', 'browser'))
    calls.length = 0
    await rt.reconcile(S('files', 'browser'), S('files', 'telegram'))
    expect(calls).toEqual(['stop:browser', 'start:telegram'])
  })

  it('hook melempar tidak menghentikan hook lain; warn hanya id+fase', async () => {
    const calls: string[] = []
    rt.onCapabilityChange('browser', { start: () => { throw new Error('token=SECRET-123 gagal') }, stop: () => undefined })
    rt.onCapabilityChange('browser', hook('ok', calls))
    rt.onCapabilityChange('files', hook('f', calls))
    await expect(rt.reconcile(S(), S('browser', 'files'))).resolves.toBeUndefined()
    expect(calls).toEqual(['start:ok', 'start:f'])
    const [w] = logBus.query().filter((e) => e.event === 'capability.hook_failed')
    expect(w.data).toEqual({ capability: 'browser', phase: 'start' })
    expect(JSON.stringify(logBus.query())).not.toContain('SECRET-123')
  })

  it('hook async ditunggu; pembatal daftar bekerja', async () => {
    const calls: string[] = []
    const off = rt.onCapabilityChange('files', {
      start: async () => { await Promise.resolve(); calls.push('start') },
      stop: () => undefined,
    })
    await rt.reconcile(S(), S('files'))
    expect(calls).toEqual(['start'])
    off()
    await rt.reconcile(S('files'), S())
    await rt.reconcile(S(), S('files'))
    expect(calls).toEqual(['start'])
  })
})
