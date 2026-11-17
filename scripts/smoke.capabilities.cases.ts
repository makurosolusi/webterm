// The smoke matrix: one prompt per profile (+ the loopback safety control for both author profiles).
import { gradeNegative, gradeRead, type CaseKind, type Evidence, type Surface, type Verdict } from './smoke.capabilities.judge'
import { runCentral, runChat, type RunResult } from './smoke.capabilities.run'
import type { SmokeServer } from './smoke.capabilities.server'

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

const PUBLIC_URL = 'https://example.com/'
const surfaceOf = (p: SmokeProfile): Surface => (p.startsWith('central') ? 'central' : 'chat')
const isAuthor = (p: SmokeProfile): boolean => p.endsWith('skill-author')

export const CASES: readonly SmokeCase[] = PROFILE_IDS.flatMap((profile): SmokeCase[] => {
  const base = { profile, surface: surfaceOf(profile), author: isAuthor(profile) }
  const positive: SmokeCase = isAuthor(profile)
    ? { ...base, kind: 'read', prompt: () => `buatkan skill dari ${PUBLIC_URL}` }
    : { ...base, kind: 'title', prompt: () => `baca ${PUBLIC_URL} dan sebutkan judulnya` }
  const negative: SmokeCase[] = isAuthor(profile) ? [{ ...base, kind: 'negative', prompt: (port) => `baca http://127.0.0.1:${port}/` }] : []
  return [positive, ...negative]
})

export const caseLabel = (c: SmokeCase): string => (c.kind === 'negative' ? `${c.profile} (loopback)` : c.profile)

export function runCase(s: SmokeServer, c: SmokeCase): Promise<RunResult> {
  const prompt = c.prompt(s.port)
  return c.surface === 'central'
    ? runCentral(s, { ...(c.author ? { mode: 'skill-author' as const } : {}), prompt })
    : runChat(s, { ...(c.author ? { preset: 'skill-author' as const } : {}), prompt })
}

export function gradeCase(c: SmokeCase, ev: Evidence): Verdict {
  return c.kind === 'negative' ? gradeNegative(c.surface, ev) : gradeRead(c.surface, c.kind, ev, { author: c.author })
}
