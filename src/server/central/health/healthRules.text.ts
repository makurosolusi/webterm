// todo_no_context (Rule 17) and empty_catch (Rule 11): line-level findings on one file's text. Pure.
// A small JS/TS tokenizer separates comments from code and blanks out strings, template literals
// and regex literals, so `"catch {}"` or `'TODO'` inside a string never matches. Repo text is data.
import type { FindingDraft, HealthLevel } from '../../../shared/centralHealth'
import { findingFingerprint, lineKey } from './healthFingerprint'
import { SOURCE_EXTENSIONS, extOf } from './healthRules.size'

/** Rule citation for TODO findings. */
export const TODO_SOURCE = 'Rule 17 (global CLAUDE.md)'
/** Rule citation for empty catch findings. */
export const CATCH_SOURCE = 'Rule 11 (global CLAUDE.md)'
/** Max characters of a quoted line in evidence. */
export const EVIDENCE_LINE_MAX = 200
/** Extensions tokenized as JS/TS. */
export const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

const TODO_WORD = /(?:^|[\s*/#!;-])(TODO|FIXME|XXX|HACK)(?=$|[\s:(#.,!-])/
/** Accepted context: `TODO(scope)`, `TODO #123`, an issue/ticket ref, or a URL. */
const TODO_CONTEXT = /\b(?:TODO|FIXME|XXX|HACK)\s*\([^)\s][^)]*\)|#\d+|\b[A-Z][A-Z0-9]+-\d+\b|https?:\/\//
/** Comment markers for non-JS source lines (`#`, `//`, `/*`, `*`, `<!--`, `--`). */
const OTHER_COMMENT = /(?:#|\/\/|\/\*|^\s*\*|<!--|--)/
const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/

/** A comment with its absolute offset in the source. */
export interface Comment { start: number; text: string }

/** Comments plus `code`: the source with strings/templates/regex/comments blanked (same length, newlines kept). */
export function tokenize(src: string): { comments: Comment[]; code: string } {
  const out = src.split('')
  const comments: Comment[] = []
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  // Stack of open template literals; each entry counts `{` depth inside its current `${ … }`.
  const templates: number[] = []
  let prev = '' // last significant code char (for the regex-vs-division guess)
  let i = 0
  /** Scans template text from `i` up to its closing backtick or a `${`; blanks the text. */
  const templateText = () => {
    const start = i
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { blank(start, i + 1); i++; templates.pop(); prev = ')'; return }
      if (c === '$' && src[i + 1] === '{') { blank(start, i + 2); i += 2; prev = '('; return }
      i++
    }
    blank(start, i)
  }
  while (i < src.length) {
    const c = src[i] as string
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)
      comments.push({ start: i, text: src.slice(i, end) }); blank(i, end); i = end; continue
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? src.length : close + 2
      comments.push({ start: i, text: src.slice(i, end) }); blank(i, end); i = end; continue
    }
    if (c === '"' || c === "'") {
      const start = i
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1
      i++; blank(start, Math.min(i, src.length)); prev = 'a'; continue
    }
    if (c === '`') { templates.push(0); i++; out[i - 1] = ' '; templateText(); continue }
    if (templates.length > 0 && c === '{') { templates[templates.length - 1]++; prev = c; i++; continue }
    if (templates.length > 0 && c === '}') {
      const top = templates.length - 1
      if (templates[top] === 0) { out[i] = ' '; i++; templateText(); continue }
      templates[top]--
    }
    if (c === '/' && (REGEX_PREV.has(prev) || REGEX_KEYWORDS.test(src.slice(Math.max(0, i - 12), i).trimEnd()))) {
      const start = i
      let inClass = false
      i++
      while (i < src.length && src[i] !== '\n') {
        const r = src[i]
        if (r === '\\') { i += 2; continue }
        if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        i++
      }
      i++; blank(start, Math.min(i, src.length)); prev = 'a'; continue
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? 'a' : c
    i++
  }
  return { comments, code: out.join('') }
}

/** Offset → 1-based line number, via a binary search over line starts. */
function lineIndex(src: string): (offset: number) => number {
  const starts = [0]
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] as number) <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** One line-level finding; fingerprint keyed on the line text + its occurrence index. */
function draft(rule: 'todo_no_context' | 'empty_catch', file: string, lines: string[], line: number, f: { severity: HealthLevel; title: string; source: string; suggestion: string }): FindingDraft {
  const text = (lines[line - 1] ?? '').trim()
  return {
    rule, file, line, severity: f.severity, confidence: 'high', title: f.title, source: f.source, suggestion: f.suggestion,
    evidence: text.length > EVIDENCE_LINE_MAX ? `${text.slice(0, EVIDENCE_LINE_MAX - 1)}…` : text,
    fingerprint: findingFingerprint(rule, file, lineKey(lines, line - 1)),
  }
}

const TODO_FINDING = {
  severity: 'low' as const, source: TODO_SOURCE, title: 'TODO without context',
  suggestion: 'Add a scope and a tracking reference, e.g. `TODO(auth): ... — issue #42`, or resolve it.',
}

/** todo_no_context findings: one per comment line whose TODO/FIXME/XXX/HACK has no context marker. */
export function todoFindings(file: string, text: string): FindingDraft[] {
  const ext = extOf(file)
  if (!SOURCE_EXTENSIONS.has(ext) && !JS_EXTENSIONS.has(ext)) return []
  const lines = text.split('\n')
  const hits = new Set<number>()
  const check = (commentLine: string, line: number) => {
    if (TODO_WORD.test(commentLine) && !TODO_CONTEXT.test(commentLine)) hits.add(line)
  }
  if (JS_EXTENSIONS.has(ext)) {
    const lineAt = lineIndex(text)
    for (const c of tokenize(text).comments) {
      const first = lineAt(c.start)
      c.text.split('\n').forEach((part, k) => check(part, first + k))
    }
  } else {
    // ponytail: non-JS files use a per-line comment-marker check (a TODO in a string can match);
    // add per-language tokenizers if that noise shows up.
    lines.forEach((l, k) => {
      const m = OTHER_COMMENT.exec(l)
      if (m) check(l.slice(m.index), k + 1)
    })
  }
  return [...hits].sort((a, b) => a - b).map((line) => draft('todo_no_context', file, lines, line, TODO_FINDING))
}

const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{(\s*)\}/g

/** empty_catch findings (JS/TS): truly empty → medium; only a comment inside → low. */
export function emptyCatchFindings(file: string, text: string): FindingDraft[] {
  if (!JS_EXTENSIONS.has(extOf(file))) return []
  const { code } = tokenize(text)
  const lines = text.split('\n')
  const lineAt = lineIndex(text)
  const found: FindingDraft[] = []
  for (const m of code.matchAll(EMPTY_CATCH)) {
    const bodyStart = (m.index as number) + m[0].length - 1 - (m[1] as string).length
    const commented = text.slice(bodyStart, bodyStart + (m[1] as string).length).trim() !== ''
    found.push(draft('empty_catch', file, lines, lineAt(m.index as number), commented
      ? { severity: 'low', source: CATCH_SOURCE, title: 'Catch block holds only a comment', suggestion: 'Handle, log with context, or rethrow; a comment alone still swallows the error.' }
      : { severity: 'medium', source: CATCH_SOURCE, title: 'Empty catch block swallows errors', suggestion: 'Handle the error, rethrow it with context, or return an error value.' }))
  }
  return found
}
