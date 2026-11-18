// The smoke matrix: one prompt per profile (+ the loopback safety control for both author profiles).
import { gradeBrowserIntent, gradeDirect, gradeNegative, gradeRead, type CaseKind, type Evidence, type Surface, type Verdict } from './smoke.capabilities.judge'
import { gradeProfile, gradeProfileDenied, PROFILE_PROMPT_CENTRAL, PROFILE_PROMPT_CHAT } from './smoke.capabilities.profile'
import { browserNodeIds, clearBrowserNodes, countDrafts, runCentral, runChat, type RunResult } from './smoke.capabilities.run'
import type { SmokeServer } from './smoke.capabilities.server'
import { gradeTabDenied, gradeTabMulti, gradeTabOpen, tabDeniedPrompt, tabMultiPrompt, tabOpenPrompt, tabsSite } from './smoke.capabilities.tabs'

export const PROFILE_IDS = ['central.skill-author', 'chat.skill-author', 'chat.default', 'central.steward'] as const
export type SmokeProfile = (typeof PROFILE_IDS)[number]

export interface SmokeCase {
  profile: SmokeProfile
  kind: CaseKind
  surface: Surface
  author: boolean
  /** Prompt; the negative control needs the live server port. */
  prompt: (port: number) => string
}

/** The owner's own first-use wording (2026-11-17): topic and name are in the message, so nothing may be asked back. */
const DIRECT_PROMPT = 'buatkan satu skill namanya contoh untuk percontohan pertama'
const PUBLIC_URL = 'https://example.com/'
const surfaceOf = (p: SmokeProfile): Surface => (p.startsWith('central') ? 'central' : 'chat')
const isAuthor = (p: SmokeProfile): boolean => p.endsWith('skill-author')

export const CASES: readonly SmokeCase[] = PROFILE_IDS.flatMap((profile): SmokeCase[] => {
  const base = { profile, surface: surfaceOf(profile), author: isAuthor(profile) }
  const positive: SmokeCase = isAuthor(profile)
    ? { ...base, kind: 'read', prompt: () => `buatkan skill dari ${PUBLIC_URL}` }
    : { ...base, kind: 'title', prompt: () => `baca ${PUBLIC_URL} dan sebutkan judulnya` }
  const negative: SmokeCase[] = isAuthor(profile) ? [{ ...base, kind: 'negative', prompt: (port) => `baca http://127.0.0.1:${port}/` }] : []
  const direct: SmokeCase[] = isAuthor(profile) ? [{ ...base, kind: 'direct', prompt: () => DIRECT_PROMPT }] : []
  // Explicit browser intent, plain chat only: the model must drive the node, not fall back to WebFetch/curl.
  const intent: SmokeCase[] = profile === 'chat.default'
    ? [
        { ...base, kind: 'open', prompt: () => `Open ${PUBLIC_URL} in a browser node and tell me the page title and the first heading you see` },
        { ...base, kind: 'interact', prompt: () => `Open ${PUBLIC_URL}, click the link on the page and tell me where it goes` },
      ]
    : []
  // Browser profiles (separate logins): the steward and a plain chat must pick the named profile; the author must not be able to.
  const profiles: SmokeCase[] = profile === 'central.steward' ? [{ ...base, kind: 'profile', prompt: () => PROFILE_PROMPT_CENTRAL }]
    : profile === 'chat.default' ? [{ ...base, kind: 'profile', prompt: () => PROFILE_PROMPT_CHAT }]
    : profile === 'chat.skill-author' ? [{ ...base, kind: 'profile-denied', prompt: () => PROFILE_PROMPT_CHAT }] : []
  // Browser tabs: one node, many pages. The plain chat follows a target=_blank link into a new tab, the steward opens a second tab itself, the author cannot.
  const tabs: SmokeCase[] = profile === 'chat.default' ? [{ ...base, kind: 'tab-open', prompt: () => tabOpenPrompt(tabsSite.port) }]
    : profile === 'central.steward' ? [{ ...base, kind: 'tab-multi', prompt: () => tabMultiPrompt(tabsSite.port) }]
    : profile === 'chat.skill-author' ? [{ ...base, kind: 'tab-denied', prompt: () => tabDeniedPrompt(tabsSite.port) }] : []
  return [positive, ...negative, ...direct, ...intent, ...profiles, ...tabs]
})

export const caseLabel = (c: SmokeCase): string => (c.kind === 'negative' ? `${c.profile} (loopback)` : c.kind === 'direct' ? `${c.profile} (direct)` : c.kind === 'open' || c.kind === 'interact' || c.kind === 'profile' || c.kind === 'profile-denied' || c.kind === 'tab-open' || c.kind === 'tab-multi' || c.kind === 'tab-denied' ? `${c.profile} (${c.kind})` : c.profile)

export async function runCase(s: SmokeServer, c: SmokeCase): Promise<RunResult> {
  if (c.kind.startsWith('tab-')) await clearBrowserNodes(s)
  const before = c.kind.startsWith('tab-') ? await browserNodeIds(s) : []
  const run = await runRaw(s, c)
  if (c.kind === 'direct') return { ...run, evidence: { ...run.evidence, drafts: await countDrafts(s) } }
  if (!c.kind.startsWith('tab-')) return run
  const added = (await browserNodeIds(s)).filter((id) => !before.includes(id)).length
  return { ...run, evidence: { ...run.evidence, newBrowserNodes: added } }
}

function runRaw(s: SmokeServer, c: SmokeCase): Promise<RunResult> {
  const prompt = c.prompt(s.port)
  return c.surface === 'central'
    ? runCentral(s, { ...(c.author ? { mode: 'skill-author' as const } : {}), prompt })
    : runChat(s, { ...(c.author ? { preset: 'skill-author' as const } : {}), prompt })
}

export function gradeCase(c: SmokeCase, ev: Evidence): Verdict {
  if (c.kind === 'direct') return gradeDirect(c.surface, ev)
  if (c.kind === 'profile') return gradeProfile(c.surface, ev)
  if (c.kind === 'profile-denied') return gradeProfileDenied(ev)
  if (c.kind === 'tab-open') return gradeTabOpen(ev)
  if (c.kind === 'tab-multi') return gradeTabMulti(ev)
  if (c.kind === 'tab-denied') return gradeTabDenied(ev)
  if (c.kind === 'open' || c.kind === 'interact') return gradeBrowserIntent(c.kind, ev)
  return c.kind === 'negative' ? gradeNegative(c.surface, ev) : gradeRead(c.surface, c.kind, ev, { author: c.author })
}
