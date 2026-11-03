// Satu-satunya pembaca runtime untuk kunci katalog kemampuan (pagar grep: featureCapabilities.grep.test.ts).
import { CAPABILITIES, CAPABILITY_IDS, type CapabilityId } from '../shared/featureCapabilities'
import { flagOn } from './envFlag'
import { createLogger } from './logs'

const log = createLogger('capabilities')

export interface CapabilityHook { start(): void | Promise<void>; stop(): void | Promise<void> }

/** Hook + status jalan, supaya start/stop idempoten walau reconcile dipanggil berulang. */
interface Registration { hook: CapabilityHook; running: boolean }
const registry = new Map<CapabilityId, Set<Registration>>()

// Penjaga siklus: katalog sekarang DAG, tetapi data berubah di masa depan; siklus dianggap off.
function enabledIn(id: CapabilityId, env: NodeJS.ProcessEnv, path: readonly CapabilityId[]): boolean {
  if (path.includes(id)) return false
  const def = CAPABILITIES[id]
  return flagOn(env[def.primaryKey]) && def.implies.every((dep) => enabledIn(dep, env, [...path, id]))
}

/** Kemampuan on bila kunci primernya on DAN semua prasyarat (`implies`, rekursif) on. */
export function isEnabled(id: CapabilityId, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledIn(id, env, [])
}

/** Himpunan kemampuan yang on pada `env`; selalu tertutup `implies`. */
export function enabledSet(env: NodeJS.ProcessEnv = process.env): ReadonlySet<CapabilityId> {
  return new Set(CAPABILITY_IDS.filter((id) => isEnabled(id, env)))
}

/** Daftarkan hook start/stop untuk `id`; mengembalikan fungsi pembatal daftar. */
export function onCapabilityChange(id: CapabilityId, hook: CapabilityHook): () => void {
  const reg: Registration = { hook, running: false }
  const set = registry.get(id) ?? new Set<Registration>()
  set.add(reg)
  registry.set(id, set)
  return () => { set.delete(reg) }
}

// Galat hook ditangkap supaya hook/kemampuan lain tetap berjalan; log hanya id + fase (tanpa pesan galat: bisa memuat secret).
async function run(id: CapabilityId, reg: Registration, phase: 'start' | 'stop'): Promise<void> {
  if (reg.running === (phase === 'start')) return
  try {
    await reg.hook[phase]()
    reg.running = phase === 'start'
  } catch {
    log.warn('capability.hook_failed', 'Capability hook failed', { capability: id, phase })
  }
}

/** Selaraskan hook dengan perubahan prev->next: stop dependents dulu (urut terbalik), lalu start prasyarat dulu. */
export async function reconcile(prev: ReadonlySet<CapabilityId>, next: ReadonlySet<CapabilityId>): Promise<void> {
  for (const id of [...CAPABILITY_IDS].reverse()) {
    if (!prev.has(id) || next.has(id)) continue
    for (const reg of [...(registry.get(id) ?? [])]) await run(id, reg, 'stop')
  }
  for (const id of CAPABILITY_IDS) {
    if (prev.has(id) || !next.has(id)) continue
    for (const reg of [...(registry.get(id) ?? [])]) await run(id, reg, 'start')
  }
}
