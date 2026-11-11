// file_size: Rule 8 (global CLAUDE.md) line/char limits measured on one file's text. Pure.
import type { FindingDraft, HealthLevel } from '../../../shared/centralHealth'
import { findingFingerprint } from './healthFingerprint'

/** Rule 8 hard limit: lines per file. */
export const HARD_LINE_LIMIT = 500
/** Rule 8 hard limit: characters per file. */
export const HARD_CHAR_LIMIT = 20_000
/** Rule 8 limit for test files: lines per file. */
export const TEST_LINE_LIMIT = 400
/** Share of a limit at which a file is reported as approaching it (Rule 8: ≥80% → suggest a split). */
export const APPROACH_RATIO = 0.8
/** Rule citation carried by every size finding. */
export const SIZE_SOURCE = 'Rule 8 (global CLAUDE.md)'

/** Extensions the size rule (and the TODO rule) treat as source code. */
export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.css', '.scss', '.vue', '.svelte',
])

const EXEMPT = [
  /Schema[^/]*V\d+[^/]*$/, // versioned schema migrations (ledgerSchemaV30.ts)
  /(^|\/)migrations?\//,
  /(^|\/)(__)?fixtures?(__)?\//,
  /\.fixtures?\.[^/]+$/,
  /\.testutil\.[^/]+$/,
  /(^|\/)generated\//,
  /\.(generated|gen)\.[^/]+$/,
]

/** Lowercased extension of a posix path ('' when none); `.d.ts` reads as `.ts`. */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** True for test files (`*.test.*`, `*.spec.*`, `__tests__/`). */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)__tests__\//.test(path)
}

/** True when Rule 8 exempts the path (migration, fixture, test util, generated). */
export function isSizeExempt(path: string): boolean {
  return EXEMPT.some((re) => re.test(path))
}

/** Thousands grouped with a space: 21403 → "21 403". */
function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Line count as an editor shows it (a trailing newline does not open a new line). */
export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** Size findings for one file (0 or 1). */
export function sizeFindings(file: string, text: string): FindingDraft[] {
  if (!SOURCE_EXTENSIONS.has(extOf(file)) || isSizeExempt(file)) return []
  const lines = countLines(text)
  const chars = text.length
  const test = isTestFile(file)
  const lineLimit = test ? TEST_LINE_LIMIT : HARD_LINE_LIMIT
  const evidence = `${group(lines)} lines, ${group(chars)} chars (limit ${group(lineLimit)} lines / ${group(HARD_CHAR_LIMIT)} chars)`
  let severity: HealthLevel
  let title: string
  let suggestion: string
  if (lines > HARD_LINE_LIMIT || chars > HARD_CHAR_LIMIT) {
    severity = 'high'
    title = 'File exceeds the hard size limit'
    suggestion = 'Split the file by responsibility; Rule 8 rejects new code in over-limit files.'
  } else if (test && lines > TEST_LINE_LIMIT) {
    severity = 'medium'
    title = 'Test file exceeds the test size limit'
    suggestion = 'Split the test file by behaviour under test.'
  } else if (lines >= lineLimit * APPROACH_RATIO || chars >= HARD_CHAR_LIMIT * APPROACH_RATIO) {
    severity = 'low'
    title = 'File is approaching the size limit'
    suggestion = 'Plan a split before adding more code here.'
  } else {
    return []
  }
  return [{
    rule: 'file_size', severity, confidence: 'high', file, line: null, title, evidence,
    source: SIZE_SOURCE, suggestion, fingerprint: findingFingerprint('file_size', file),
  }]
}
