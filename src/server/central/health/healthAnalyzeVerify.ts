// Server-side check of a deep analysis answer (H4): a model claim becomes a finding only when its file is
// tracked, its line exists and its quote is really there (line ±3, whitespace-normalised). Everything
// else is dropped and counted by reason. A verified quote proves WHERE, not that the judgement is right,
// so analysis findings are never `high` confidence.
import { join } from 'node:path'
import type { FindingDraft, HealthLevel } from '../../../shared/centralHealth'
import { findingFingerprint, normalizeLine } from './healthFingerprint'
import { ANALYSIS_CATEGORIES, ANALYSIS_MAX_FINDINGS, type AnalysisCategory } from './healthAnalyzePrompt'
import { DEFAULT_MAX_BYTES_PER_FILE, readText } from './healthScan'

export const QUOTE_MIN_CHARS = 8
/** Lines on each side of `line` where the quote may sit (models are often off by one or two). */
export const QUOTE_WINDOW = 3
const TITLE_MAX = 200
const EVIDENCE_MAX = 500
const SUGGESTION_MAX = 500
const SOURCE_MAX = 200
export const NO_RULE_SOURCE = 'Suggestion (no project rule)'
const LEVELS: readonly HealthLevel[] = ['high', 'medium', 'low']
/**
 * Only risk/tests claims keep `high` severity: those are where a missed fix costs most (security, untested
 * critical code). Structure, duplication and convention are opinions and stay at most `medium`.
 */
const HIGH_ALLOWED: ReadonlySet<AnalysisCategory> = new Set(['risk', 'tests'])
/** Files whose content must never be quoted back, even when tracked (mirrors `ANALYZE_READ_DENY`). */
const SECRET_FILE = /(^|\/)(\.env(rc)?(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx)|credentials[^/]*\.json|[^/]*secret[^/]*\.(json|ya?ml|txt)|secrets\/.*)$/i
const TEMPLATE = /\.(example|sample|template)$/i

export type DropReason = 'malformed' | 'bad_path' | 'untracked_file' | 'secret_file' | 'bad_line' | 'short_quote' | 'quote_not_found' | 'duplicate' | 'over_limit'
export type DropCounts = Partial<Record<DropReason, number>>

/** What the verifier needs from the repo. */
export interface VerifyInput {
  cwd: string
  tracked: ReadonlySet<string>
  /** Rule texts a cited source may come from: the repo's CLAUDE.md, the global rules file. */
  ruleTexts: readonly string[]
  /** Test seam: file reader (default: `readText` with the scan's size cap). */
  read?: (abs: string) => Promise<string | null>
}

export interface VerifyResult { drafts: FindingDraft[]; dropped: DropCounts; checked: number }

interface Claim { title: string; file: string; line: number; quote: string; evidence: string; suggestion: string; severity: HealthLevel; category: AnalysisCategory; source: string }

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function asClaim(v: unknown): Claim | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (![c.title, c.file, c.quote, c.evidence, c.suggestion].every(text)) return null
  if (typeof c.line !== 'number' || !Number.isInteger(c.line)) return null
  if (!LEVELS.includes(c.severity as HealthLevel) || !(ANALYSIS_CATEGORIES as readonly unknown[]).includes(c.category)) return null
  return { ...(c as unknown as Claim), source: typeof c.source === 'string' ? c.source.trim() : '' }
}

/** Repo-relative, no `..`, no absolute or Windows-style path. */
export const isSafeRelative = (p: string): boolean =>
  p !== '' && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '')

/** Whether `quote` appears in `lines` within `line` ± QUOTE_WINDOW (1-based), whitespace-normalised. */
export function quoteNear(lines: readonly string[], line: number, quote: string): boolean {
  const want = normalizeLine(quote)
  const from = Math.max(0, line - 1 - QUOTE_WINDOW)
  const window = lines.slice(from, line + QUOTE_WINDOW).map(normalizeLine).join(' ')
  return window.includes(want)
}

/** Whether `source` cites a rule that exists in one of `ruleTexts` (by "Rule N" or by its wording). */
export function citesKnownRule(source: string, ruleTexts: readonly string[]): boolean {
  if (source === '' || /^none\.?$/i.test(source)) return false
  const n = /\brule\s*#?(\d{1,3})\b/i.exec(source)?.[1]
  if (n) return ruleTexts.some((t) => new RegExp(`\\brule\\s*#?${n}\\b|^#{1,6}\\s*${n}[.)]\\s`, 'im').test(t))
  const excerpt = normalizeLine(source.replace(/^claude\.md\s*[:\-—]?\s*/i, '').replace(/^["'“”]+|["'“”]+$/g, '')).toLowerCase()
  return excerpt.length >= QUOTE_MIN_CHARS && ruleTexts.some((t) => normalizeLine(t).toLowerCase().includes(excerpt))
}

/** Verifies a raw analysis answer; never throws on model output, only on a failing file read. */
export async function verifyAnalysis(raw: unknown, input: VerifyInput): Promise<VerifyResult> {
  const read = input.read ?? ((abs: string) => readText(abs, DEFAULT_MAX_BYTES_PER_FILE))
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings) ? (raw as { findings: unknown[] }).findings : []
  const dropped: DropCounts = {}
  const drop = (r: DropReason): void => { dropped[r] = (dropped[r] ?? 0) + 1 }
  const drafts: FindingDraft[] = []
  const seen = new Set<string>()
  const files = new Map<string, string[] | null>()
  for (const [i, item] of items.entries()) {
    if (i >= ANALYSIS_MAX_FINDINGS) { drop('over_limit'); continue }
    const c = asClaim(item)
    if (!c) { drop('malformed'); continue }
    const file = c.file.trim().replace(/^\.\//, '')
    if (!isSafeRelative(file)) { drop('bad_path'); continue }
    if (!input.tracked.has(file)) { drop('untracked_file'); continue }
    if (SECRET_FILE.test(file) && !TEMPLATE.test(file)) { drop('secret_file'); continue }
    const quote = c.quote.trim()
    if (normalizeLine(quote).length < QUOTE_MIN_CHARS) { drop('short_quote'); continue }
    if (!files.has(file)) files.set(file, (await read(join(input.cwd, file)))?.split('\n') ?? null)
    const lines = files.get(file)
    if (!lines || c.line < 1 || c.line > lines.length) { drop('bad_line'); continue }
    if (!quoteNear(lines, c.line, quote)) { drop('quote_not_found'); continue }
    const fingerprint = findingFingerprint('analysis', file, `${c.category}|${normalizeLine(quote)}`)
    if (seen.has(fingerprint)) { drop('duplicate'); continue }
    seen.add(fingerprint)
    const severity: HealthLevel = c.severity === 'high' && !HIGH_ALLOWED.has(c.category) ? 'medium' : c.severity
    drafts.push({
      rule: 'analysis', severity, confidence: 'medium', file, line: c.line, fingerprint,
      title: clip(c.title.trim(), TITLE_MAX),
      evidence: clip(`"${normalizeLine(quote)}" — ${c.evidence.trim()}`, EVIDENCE_MAX),
      source: citesKnownRule(c.source, input.ruleTexts) ? clip(`CLAUDE.md: ${c.source}`, SOURCE_MAX) : NO_RULE_SOURCE,
      suggestion: clip(c.suggestion.trim(), SUGGESTION_MAX),
    })
  }
  return { drafts, dropped, checked: files.size }
}
