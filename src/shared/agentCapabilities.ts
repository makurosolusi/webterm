// Pure derivations from the capability registry (agentCapabilities.data.ts): the capability list of a profile, the
// system-prompt briefing, a one-line UI text, a stable hash, and the enforcement lists (Central tools, chat families).
import { CAPABILITIES, PROFILES, type CapabilityDef, type CapabilityId, type ChatFamily, type ProfileId } from './agentCapabilities.data'

export { CAPABILITIES, PROFILES } from './agentCapabilities.data'
export type { CapabilityDef, CapabilityId, ChatFamily, ProfileId } from './agentCapabilities.data'

export interface ProfileCapability extends CapabilityDef { level: 'granted' | 'denied' }

/** Every capability with its level for `profileId`, in registry order. */
export function capabilitiesOf(profileId: ProfileId): ProfileCapability[] {
  const granted = new Set<CapabilityId>(PROFILES[profileId].granted)
  return Object.values(CAPABILITIES).map((c) => ({ ...c, level: granted.has(c.id) ? 'granted' : 'denied' }))
}

const withLevel = (profileId: ProfileId, level: ProfileCapability['level']): ProfileCapability[] => capabilitiesOf(profileId).filter((c) => c.level === level)
const surfaceOf = (profileId: ProfileId): 'central' | 'chat' => (profileId.startsWith('central.') ? 'central' : 'chat')

/** Registry tool names a Central profile may call (derives `MODE_TOOLS`). */
export const grantedCentralTools = (profileId: ProfileId): string[] => withLevel(profileId, 'granted').flatMap((c) => c.central?.tools ?? [])

/** `webterm <family>` command families a chat profile may run (derives the tool lock). */
export const grantedChatFamilies = (profileId: ProfileId): ChatFamily[] => withLevel(profileId, 'granted').flatMap((c) => (c.chat?.family ? [c.chat.family] : []))

const callForm = (profileId: ProfileId, c: CapabilityDef): string | undefined => PROFILES[profileId].override?.[c.id]?.usage ?? (surfaceOf(profileId) === 'central' ? c.central?.usage : c.chat?.usage)
const NONE: ReadonlySet<CapabilityId> = new Set()
const summaryOf = (profileId: ProfileId, c: CapabilityDef): string => PROFILES[profileId].override?.[c.id]?.summary ?? c.summary
const rulesOf = (profileId: ProfileId, c: CapabilityDef): readonly string[] => PROFILES[profileId].override?.[c.id]?.rules ?? c.rules ?? []

/** Granted abilities split by the live switch: `off` = granted on paper but unusable right now (feature off, tool off). */
function splitOff(profileId: ProfileId, off: ReadonlySet<CapabilityId>): { on: ProfileCapability[]; off: ProfileCapability[] } {
  const granted = withLevel(profileId, 'granted')
  return { on: granted.filter((c) => !off.has(c.id)), off: granted.filter((c) => off.has(c.id)) }
}

/** Sentences of some abilities (summary, call form, rules) for a hand-written prompt that carries only part of the briefing; an `off` ability says it is not available. */
export function renderCapabilityProse(profileId: ProfileId, ids: readonly CapabilityId[], off: ReadonlySet<CapabilityId> = NONE): string {
  return capabilitiesOf(profileId).filter((c) => c.level === 'granted' && ids.includes(c.id)).map((c) => {
    if (off.has(c.id)) return `Not available right now (switched off): ${c.short}.`
    const how = callForm(profileId, c)
    return [`${summaryOf(profileId, c)}${how ? ` How: ${how}.` : ''}`, ...rulesOf(profileId, c)].join(' ')
  }).join(' ')
}

/** "WHAT YOU CAN DO / CANNOT DO" block of a system prompt; every sentence comes from the registry. `off` lists granted abilities that are switched off right now. */
export function renderCapabilityBriefing(profileId: ProfileId, off: ReadonlySet<CapabilityId> = NONE): string {
  const split = splitOff(profileId, off)
  const can = split.on.flatMap((c) => {
    const how = callForm(profileId, c)
    return [`- ${summaryOf(profileId, c)}${how ? ` How: ${how}.` : ''}`, ...rulesOf(profileId, c).map((r) => `  Rule: ${r}`)]
  })
  const cannot = PROFILES[profileId].listDenied === false ? [] : withLevel(profileId, 'denied').map((c) => `- ${c.denied}`)
  const unavailable = split.off.map((c) => `- ${c.short} (switched off in this webterm; say so in one sentence, do not try).`)
  return [
    ...(can.length ? ['WHAT YOU CAN DO', ...can, ''] : []),
    ...(unavailable.length ? ['NOT AVAILABLE RIGHT NOW', ...unavailable, ''] : []),
    ...(cannot.length ? ['WHAT YOU CANNOT DO', ...cannot, ''] : []),
    `${can.length ? 'Everything under CAN is available now: use it instead of asking the human to do it, and never claim it is unavailable without having tried.' : ''}${cannot.length ? ' For anything under CANNOT, say so in one sentence.' : ''}`.trim(),
  ].join('\n').trimEnd()
}

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** One-line capability summary for banners and tooltips (`off` abilities move to "Not available right now"). */
export function renderCapabilityLine(profileId: ProfileId, off: ReadonlySet<CapabilityId> = NONE): string {
  const split = splitOff(profileId, off)
  const cannot = PROFILES[profileId].listDenied === false ? [] : withLevel(profileId, 'denied').map((c) => c.short)
  return [
    split.on.length ? `Can ${list(split.on.map((c) => c.short))}.` : '',
    cannot.length ? `Cannot ${list(cannot)}.` : '',
    split.off.length ? `Not available right now: ${list(split.off.map((c) => c.short))}.` : '',
  ].filter(Boolean).join(' ')
}

/** Stable hash (FNV-1a, 8 hex) of the rendered briefing: changes exactly when what the agent is told changes. */
export function capabilityHash(profileId: ProfileId, off: ReadonlySet<CapabilityId> = NONE): string {
  let h = 0x811c9dc5
  for (const ch of renderCapabilityBriefing(profileId, off)) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
