// What a plain Agent Chat node is told about its own abilities (registry profile `chat.default`) and the note sent when
// they change under a running chat. Locked presets (skill-author) carry their briefing in their own role text (agentChat.role.ts).
import { renderProfileNames } from '../../shared/browser.profile.names'
import { listProfiles } from '../browser/browser.profiles.service'
import { renderCapabilityBriefing, type CapabilityId, type ProfileId } from '../../shared/agentCapabilities'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { LedgerContext } from '../ledger/ledgerCore'
import { capabilityNote, type CapabilityNote } from '../capabilityNote'
import { flagOr } from '../envFlag'
import { isEnabled } from '../featureCapabilities.runtime'
import { captureActive } from '../linkCapture/linkCapture.env'
import { agentChatLockFor } from './agentChat.toolLock'

/** Registry profile of a node: a locked preset has its own, every other node is the default chat. */
export const chatCapabilityProfile = (preset: string | undefined): ProfileId => (agentChatLockFor(preset) ? 'chat.skill-author' : 'chat.default')

/** Browser abilities are off while the browser feature or agent control of it is off (the `webterm browser` verbs refuse then). */
export function chatCapabilityOff(env: NodeJS.ProcessEnv = process.env): Set<CapabilityId> {
  const browser = isEnabled('browser', env) && flagOr(env[ENV_BROWSER.agent], true)
  const off = new Set<CapabilityId>(browser ? [] : ['web.read', 'web.drive', 'web.profiles', 'web.tabs', 'web.layout'])
  if (!captureActive(env)) off.add('web.links') // the Settings switch or the browser feature is off: new terminals keep the machine browser
  return off
}

/** The live profile names as one line; empty while the browser feature is switched off. */
const liveProfiles = (off: ReadonlySet<CapabilityId>): string => (off.has('web.profiles') ? '' : renderProfileNames(listProfiles()))

/** System-prompt briefing of a plain chat node (plus the profile names as of now); undefined for a locked preset (its role text already carries one). */
export function chatCapabilityBriefing(preset: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (chatCapabilityProfile(preset) !== 'chat.default') return undefined
  const off = chatCapabilityOff(env)
  return [renderCapabilityBriefing('chat.default', off), liveProfiles(off)].filter((p) => p !== '').join('\n')
}

/** Note for the next turn of node `nodeId` when its briefing changed since the last one it saw. */
export function chatCapabilityNote(ctx: LedgerContext, nodeId: string, preset: string | undefined, env: NodeJS.ProcessEnv = process.env): CapabilityNote | undefined {
  const profile = chatCapabilityProfile(preset)
  const off = profile === 'chat.default' ? chatCapabilityOff(env) : undefined
  return capabilityNote(ctx, `chat:${nodeId}`, profile, off, off ? liveProfiles(off) : '')
}
