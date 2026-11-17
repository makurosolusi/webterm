// Skill lint + format (RND/25 4.4-4.5): strict Agent Skills subset. Issues are codes only, never echoed content.
import { isSkillAudience } from '../contracts/skill.types'
export const SKILL_NAME_RE = /^webterm-[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_SKILL_NAME = 64
export const MAX_DESCRIPTION = 300
export const MAX_BODY_CHARS = 4000
export const MAX_FILE_BYTES = 8192
export const MAX_CAPS = 12
const CAP_RE = /^[a-z]+(\.[a-z_]+)+$/
const FRONT_KEYS = new Set(['name', 'description', 'license', 'metadata'])
const META_KEYS = new Set(['webterm.version', 'webterm.origin', 'webterm.caps', 'webterm.audience'])

export type LintIssue = 'size' | 'frontmatter' | 'unknown_key' | 'name' | 'description' | 'caps' | 'audience' | 'hidden_char' | 'traversal' | 'url' | 'danger' | 'injection' | 'secret' | 'extra_file'
export interface SkillMeta { name: string; description: string; caps: string[]; version: string | null; origin: string | null; audience: string | null }
export interface LintResult { ok: boolean; issues: LintIssue[]; meta: SkillMeta | null; body: string }
export interface LintOptions { expectedName?: string; allowedCaps?: ReadonlySet<string> }

const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/
const BASE64_RUN = /[A-Za-z0-9+/]{60,}={0,2}/
const SCANS: ReadonlyArray<readonly [LintIssue, readonly RegExp[]]> = [
  ['traversal', [/(^|[^.\w])\.\.(?=[\\/])/m, /[\\/]\.\.($|[\\/\s"'`)])/m, /(^|[\s"'`(])(~\/|\/(etc|Users|home|root|var|usr|bin|tmp|private|proc)\/|[A-Za-z]:\\)/m]],
  ['url', [/\b[a-z][a-z0-9+.-]*:\/\/\S/i, /\bdata:[a-z]+\/[a-z]/i]],
  ['danger', [/\brm\s+-[a-z]*[rf]/i, /\b(sudo|chmod|chown|mkfs|osascript|powershell)\b/i, /\bdd\s+if=/i, /:\(\)\s*\{/, /\b(curl|wget)\b/i, /\|\s*(ba|z)?sh\b/i, /\beval\s*\(/i, /\bbase64\s+(-d|--decode)/i, /\bnc\s+-/i, /!`[^`]*`/]],
  ['injection', [/\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompt|guidelines)/i, /abaikan\s+(semua\s+)?(aturan|instruksi|perintah)/i, /(reveal|print|show|leak|bocorkan)\s+.{0,30}(system prompt|secret|token|password)/i, /\b(activate|approve|enable)\s+(this|the|your own)\s+skill\b/i, /\bwithout\s+(human\s+)?(approval|confirmation)\b/i]],
  ['secret', [/\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, /\b(api[_-]?key|secret|token|passw(or)?d)\b\s*[:=]\s*["']?[^\s"']{8,}/i]],
]

type Parsed = { front: Record<string, string>; meta: Record<string, string>; body: string }
function scalar(raw: string): string | null {
  const v = raw.trim()
  if (v.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(v); return typeof parsed === 'string' ? parsed : null } catch { return null }
  }
  return /^[[{|>&*!%@`']/.test(v) ? null : v
}

function parseSkill(text: string): Parsed | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 3)
  if (end < 0) return null
  const front: Record<string, string> = {}
  const meta: Record<string, string> = {}
  let inMeta = false
  for (const line of text.slice(4, end).split('\n')) {
    const nested = /^ {2}([A-Za-z0-9_.-]+):(.*)$/.exec(line)
    const top = /^([a-z-]+):(.*)$/.exec(line)
    if (nested && inMeta) {
      const value = scalar(nested[2])
      if (value === null || nested[1] in meta) return null
      meta[nested[1]] = value
    } else if (top && !nested) {
      if (top[1] in front || (top[1] === 'metadata' && top[2].trim() !== '')) return null
      inMeta = top[1] === 'metadata'
      const value = inMeta ? '' : scalar(top[2])
      if (value === null) return null
      front[top[1]] = value
    } else return null
  }
  return { front, meta, body: text.slice(end + 5) }
}

/** Lints one SKILL.md; never throws and never returns offending content. */
export function lintSkill(text: string, opts: LintOptions = {}): LintResult {
  const issues = new Set<LintIssue>()
  const fail = (): LintResult => ({ ok: false, issues: [...issues], meta: null, body: '' })
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) { issues.add('size'); return fail() }
  if (HIDDEN.test(text.replace(/[\n\t]/g, ''))) issues.add('hidden_char')
  const parsed = parseSkill(text)
  if (!parsed) { issues.add('frontmatter'); return fail() }
  const { front, meta, body } = parsed
  if (Object.keys(front).some((k) => !FRONT_KEYS.has(k)) || Object.keys(meta).some((k) => !META_KEYS.has(k))) issues.add('unknown_key')
  const name = front.name ?? ''
  if (!SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME || (opts.expectedName !== undefined && name !== opts.expectedName)) issues.add('name')
  const description = front.description ?? ''
  if (description.length < 1 || description.length > MAX_DESCRIPTION || /[\r\n]/.test(description)) issues.add('description')
  const caps = (meta['webterm.caps'] ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  if (caps.length > MAX_CAPS || caps.some((c) => !CAP_RE.test(c) || (opts.allowedCaps && !opts.allowedCaps.has(c)))) issues.add('caps')
  // A missing key is legal: skills approved before audience existed carry none and the DB column (default central) rules.
  if (meta['webterm.audience'] !== undefined && !isSkillAudience(meta['webterm.audience'])) issues.add('audience')
  if (body.trim().length === 0 || body.length > MAX_BODY_CHARS) issues.add('size')
  const scan = text.normalize('NFKC')
  if (BASE64_RUN.test(scan)) issues.add('secret')
  for (const [code, patterns] of SCANS) if (patterns.some((re) => re.test(scan))) issues.add(code)
  const ok = issues.size === 0
  return { ok, issues: [...issues], meta: { name, description, caps, version: meta['webterm.version'] ?? null, origin: meta['webterm.origin'] ?? null, audience: meta['webterm.audience'] ?? null }, body }
}

/** Renders a SKILL.md with every value JSON-quoted so input can never add frontmatter lines. */
export function formatSkill(s: { name: string; description: string; body: string; caps: readonly string[]; version: string; origin: string; audience: string }): string {
  const meta = [`  webterm.version: ${JSON.stringify(s.version)}`, `  webterm.origin: ${JSON.stringify(s.origin)}`, `  webterm.caps: ${JSON.stringify(s.caps.join(','))}`, `  webterm.audience: ${JSON.stringify(s.audience)}`]
  return ['---', `name: ${s.name}`, `description: ${JSON.stringify(s.description)}`, 'metadata:', ...meta, '---', s.body.endsWith('\n') ? s.body : `${s.body}\n`].join('\n')
}
