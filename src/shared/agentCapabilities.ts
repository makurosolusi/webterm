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

const callForm = (c: CapabilityDef, surface: 'central' | 'chat'): string | undefined => (surface === 'central' ? c.central?.usage : c.chat?.usage)

/** "WHAT YOU CAN DO / CANNOT DO" block of a system prompt; every sentence comes from the registry. */
export function renderCapabilityBriefing(profileId: ProfileId): string {
  const surface = surfaceOf(profileId)
  const can = withLevel(profileId, 'granted').flatMap((c) => {
    const how = callForm(c, surface)
    return [`- ${c.summary}${how ? ` How: ${how}.` : ''}`, ...(c.rules ?? []).map((r) => `  Rule: ${r}`)]
  })
  const cannot = withLevel(profileId, 'denied').map((c) => `- ${c.denied}`)
  return [
    'WHAT YOU CAN DO', ...can, '',
    ...(cannot.length ? ['WHAT YOU CANNOT DO', ...cannot, ''] : []),
    'Everything under CAN is available now: use it instead of asking the human to do it, and never claim it is unavailable without having tried. For anything under CANNOT, say so in one sentence.',
  ].join('\n')
}

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** One-line capability summary for banners and tooltips. */
export function renderCapabilityLine(profileId: ProfileId): string {
  const can = withLevel(profileId, 'granted').map((c) => c.short)
  const cannot = withLevel(profileId, 'denied').map((c) => c.short)
  return `Can ${list(can)}.${cannot.length ? ` Cannot ${list(cannot)}.` : ''}`
}

/** Stable hash (FNV-1a, 8 hex) of the rendered briefing: changes exactly when what the agent is told changes. */
export function capabilityHash(profileId: ProfileId): string {
  let h = 0x811c9dc5
  for (const ch of renderCapabilityBriefing(profileId)) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
