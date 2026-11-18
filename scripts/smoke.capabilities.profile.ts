// Smoke cases for browser profiles (docs/smoke-capabilities.md): prompts and pure grading of the tool evidence.
import type { Evidence, ToolEvidence, Verdict } from './smoke.capabilities.judge'

export const PROFILE_PROMPT_CENTRAL = 'Open a browser with the profile named work and tell me which profile it uses'
export const PROFILE_PROMPT_CHAT = 'Open a browser with the profile named work (https://example.com) and tell me which profile it uses'
const PROFILE_FLAG = /webterm browser (open|navigate)\b[^&;|]*--profile\s+['"]?work\b/i
const label = (t: ToolEvidence): string => `${t.name}:${t.id.slice(-6)}=${t.state}${t.code ? `(${t.code})` : ''}`
const ids = (ev: Evidence): string => ev.tools.map(label).join(' ') || 'no tool call'

/** Steward: browser_open ran OK with profile work; chat: `webterm browser open --profile work` ran OK. The answer must name "work". */
export function gradeProfile(surface: 'central' | 'chat', ev: Evidence): Verdict {
  const hit = ev.tools.find((t) => t.state === 'ok' && (surface === 'central' ? t.name.endsWith('browser_open') && /^work$/i.test(t.profile ?? '') : t.name === 'Bash' && PROFILE_FLAG.test(t.command)))
  if (!hit) return { pass: false, evidence: `FAIL no successful ${surface === 'central' ? 'browser_open with profile work' : '`webterm browser open --profile work`'}; ${ids(ev)}` }
  if (!/\bwork\b/i.test(ev.text)) return { pass: false, evidence: `FAIL answer does not name the profile "work"; ${ids(ev)}` }
  return { pass: true, evidence: `${label(hit)}; answer names "work"` }
}

/** Control (skill-author chat): no `--profile` / `profiles` call may succeed. A refusal or no attempt both pass; only an attempt that was refused proves enforcement. */
export function gradeProfileDenied(ev: Evidence): Verdict {
  const tries = ev.tools.filter((t) => t.name === 'Bash' && /webterm browser (profiles|(open|navigate)\b.*--profile)/.test(t.command))
  const leaked = tries.filter((t) => t.state === 'ok')
  if (leaked.length > 0) return { pass: false, evidence: `FAIL a profile call succeeded for the author; ${leaked.map(label).join(' ')}` }
  if (tries.length === 0) return { pass: true, evidence: `no attempt: model declined itself, enforcement not exercised; ${ids(ev)}` }
  return { pass: true, evidence: `refused: ${tries.map(label).join(' ')}` }
}
