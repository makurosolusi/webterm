// Kunci env lama -> himpunan kemampuan (D2: tanpa penyimpanan baru; kunci lama = input legacy).
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS, type CapabilityId } from '../shared/featureCapabilities'
import { flagOn, parseFlag } from './envFlag'
import { createLogger } from './logs'

const log = createLogger('capabilities')

/** Anak yang tak diturunkan `deriveFlags` (flag rilis CA2) tapi hanya berlaku bila induk on. */
const CENTRAL_EXTRAS = [
  'WEBTERM_CENTRAL_PLANNER', 'WEBTERM_OPENCODE_ALLOW_TOOLS', 'WEBTERM_CENTRAL_SKILL_PROPOSE',
  'WEBTERM_KNOWLEDGE', 'WEBTERM_CENTRAL_RELIABILITY', 'WEBTERM_AGENT_MAIL',
]
const TELEGRAM_EXTRAS = ['WEBTERM_CENTRAL_BOTS', 'WEBTERM_CHANNEL_APPROVAL_BUTTONS']
const EXTRA_CHILDREN: readonly { key: string; needs: readonly CapabilityId[] }[] = [
  ...CENTRAL_EXTRAS.map((key) => ({ key, needs: ['central' as const] })),
  ...TELEGRAM_EXTRAS.map((key) => ({ key, needs: ['telegram' as const] })),
]

// Sub-opsi kemampuan (mis. RUN_REQUIRE_APPROVAL) ikut dihormati hanya bila induknya on.
const SUB_CHILDREN = CAPABILITY_IDS.flatMap((id) => (CAPABILITIES[id].subs ?? []).map((s) => ({ key: s.key, needs: [id] })))
const CHILDREN = [...DERIVED_FLAGS, ...EXTRA_CHILDREN, ...SUB_CHILDREN]

const warned = new Set<string>()

// Satu warn per kunci per proses; hanya NAMA kunci (nilai bisa sensitif).
function warnOnce(key: string): void {
  if (warned.has(key)) return
  warned.add(key)
  log.warn('capability.legacy_ignored', 'Legacy key ignored because its parent capability is off', { key })
}

/**
 * Petakan env lama ke himpunan kemampuan. Kunci primer on tanpa prasyarat, dan anak/sub on tanpa induk aktif,
 * masuk `ignored` (+ satu warn per kunci per proses). `WEBTERM_LEDGER` sengaja tak dibaca: ledger selalu hidup.
 */
export function legacyToCapabilities(env: NodeJS.ProcessEnv): { set: Set<CapabilityId>; ignored: string[] } {
  const set = new Set<CapabilityId>()
  const ignored: string[] = []
  // CAPABILITY_IDS urut topologis, jadi prasyarat sudah diputuskan sebelum pemakainya.
  for (const id of CAPABILITY_IDS) {
    const { primaryKey, implies } = CAPABILITIES[id]
    if (!flagOn(env[primaryKey])) continue
    if (implies.every((dep) => set.has(dep))) set.add(id)
    else ignored.push(primaryKey)
  }
  for (const { key, needs } of CHILDREN) {
    if (parseFlag(env[key]) === 'on' && !needs.every((n) => set.has(n))) ignored.push(key)
  }
  ignored.forEach(warnOnce)
  return { set, ignored }
}
