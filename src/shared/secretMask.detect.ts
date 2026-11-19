// Pure secret detector for the file-manager editor: returns which parts of a text to hide.
// No I/O, no DOM. Limits and heuristics are documented in docs/decisions/secret-masking.md.
import {
  BLOCK_SCALAR_RE, CODE_REFERENCE_RE, COMMENT_MARKER_RE, CONNECTION_STRING_RE,
  ENV_TEMPLATE_SUFFIXES, FILE_WIDE_NAME_PATTERNS, KEY_LEAD_RE, KEY_VALUE_SOURCE,
  MAX_PLACEHOLDER_CHARS, MAX_SCAN_CHARS, PLACEHOLDER_SHAPES, PLACEHOLDER_WORDS,
  PRIVATE_KEY_BLOCK_RE, SECRET_KEY_RE, SHORT_NUMBER_MAX_DIGITS, TOKEN_PATTERNS,
  VARIABLE_REF_RE,
} from './secretMask.patterns'

/** A secret value span: UTF-16 offsets `[from, to)` into the scanned text. */
export type SecretRange = { from: number; to: number; kind: string }
/** `fileWide`: hide everything. `truncated`: text past the scan limit was not examined. */
export type SecretScan = { fileWide: boolean; ranges: SecretRange[]; truncated: boolean }

type LineState = { block: boolean }

const baseName = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

function isEnvFile(name: string): boolean {
  const n = name.toLowerCase()
  if (n !== '.env' && !n.startsWith('.env.')) return false
  return !ENV_TEMPLATE_SUFFIXES.some((s) => n.endsWith(`.${s}`))
}

/** True for empty values, template references, filler words and short numbers. */
function isPlaceholder(v: string): boolean {
  if (v === '') return true
  if (v.length > MAX_PLACEHOLDER_CHARS) return false
  if (PLACEHOLDER_WORDS.has(v.toLowerCase())) return true
  if (PLACEHOLDER_SHAPES.some((re) => re.test(v))) return true
  if (v.length <= SHORT_NUMBER_MAX_DIGITS && /^\d+$/.test(v)) return true
  return v.replace(VARIABLE_REF_RE, '') === ''
}

/** Unquoted non-.env values that look like code (spaces, calls, `a.b.c`) rather than a literal. */
function looksLikeCode(v: string): boolean {
  return /\s/.test(v) || v.includes('(') || v.startsWith('=') || CODE_REFERENCE_RE.test(v)
}

/** Index of the quote closing a value that opens at `from - 1`, honouring backslash escapes. */
function findClosingQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === quote) return i
  }
  return -1
}

/** Unquoted value end: stops at ` #` and drops trailing whitespace, `,` and `;`. */
function unquotedEnd(line: string, start: number): number {
  const hash = line.indexOf(' #', start)
  let end = hash >= 0 ? hash : line.length
  while (end > start && /[\s,;]/.test(line[end - 1])) end--
  return end
}

function scanTokens(body: string, out: SecretRange[]): void {
  for (const re of TOKEN_PATTERNS) {
    for (const m of body.matchAll(re)) out.push({ from: m.index, to: m.index + m[0].length, kind: 'token' })
  }
}

function scanConnectionStrings(body: string, out: SecretRange[]): void {
  for (const m of body.matchAll(CONNECTION_STRING_RE)) {
    if (isPlaceholder(m[2])) continue
    const from = m.index + m[1].length
    out.push({ from, to: from + m[2].length, kind: 'connection-string' })
  }
}

/** Handle one key/value match; returns the index where scanning of this line should resume. */
function handlePair(
  m: RegExpExecArray, line: string, base: number, env: boolean, st: LineState, out: SecretRange[],
): number {
  const valueStart = m.index + m[0].length
  const secretKey = SECRET_KEY_RE.test(m[2])
  if (!secretKey && !env) return valueStart
  const quote = line[valueStart]
  const quoted = quote === '"' || quote === "'"
  let from = valueStart
  let to: number
  let next = line.length
  if (quoted) {
    from = valueStart + 1
    const close = findClosingQuote(line, from, quote)
    to = close < 0 ? unquotedEnd(line, from) : close
    if (close >= 0) next = close + 1
  } else {
    to = unquotedEnd(line, from)
  }
  const value = line.slice(from, to)
  if (!quoted && secretKey && BLOCK_SCALAR_RE.test(value)) st.block = true
  else if (!isPlaceholder(value) && (quoted || env || !looksLikeCode(value))) {
    out.push({ from: base + from, to: base + to, kind: secretKey ? 'key-value' : 'env-value' })
  }
  return env ? line.length : next // .env lines hold one pair; the value runs to the end
}

function scanLine(
  line: string, base: number, env: boolean, st: LineState,
  kvG: RegExp, kvY: RegExp, out: SecretRange[],
): void {
  if (st.block) {
    const trimmed = line.trim()
    if (trimmed === '') return
    st.block = false
    const from = line.length - line.trimStart().length
    out.push({ from: base + from, to: base + from + trimmed.length, kind: 'key-value' })
    return
  }
  const comment = COMMENT_MARKER_RE.exec(line)
  if (comment) {
    // Prose after a comment marker only counts when the line itself reads `KEY: value`.
    const start = comment[0].length
    kvY.lastIndex = start + (KEY_LEAD_RE.exec(line.slice(start))?.[0].length ?? 0)
    const m = kvY.exec(line)
    if (m) handlePair(m, line, base, env, st, out)
    return
  }
  kvG.lastIndex = 0
  for (let m = kvG.exec(line); m; m = kvG.exec(line)) {
    kvG.lastIndex = handlePair(m, line, base, env, st, out)
    if (st.block || kvG.lastIndex >= line.length) break
  }
}

function scanLines(body: string, env: boolean, out: SecretRange[]): void {
  const kvG = new RegExp(KEY_VALUE_SOURCE, 'g')
  const kvY = new RegExp(KEY_VALUE_SOURCE, 'y')
  const st: LineState = { block: false }
  for (let pos = 0; pos <= body.length; ) {
    let end = body.indexOf('\n', pos)
    if (end < 0) end = body.length
    const lineEnd = end > pos && body[end - 1] === '\r' ? end - 1 : end
    scanLine(body.slice(pos, lineEnd), pos, env, st, kvG, kvY, out)
    pos = end + 1
  }
}

/** Sort and merge overlapping ranges; touching ranges stay separate. */
function normalize(ranges: SecretRange[]): SecretRange[] {
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)
  const merged: SecretRange[] = []
  for (const r of ranges) {
    const prev = merged[merged.length - 1]
    if (prev && r.from < prev.to) prev.to = Math.max(prev.to, r.to)
    else merged.push({ ...r })
  }
  return merged
}

/** Find the secret values in `text` (file `path` decides name-based rules); pure and linear-time. */
export function detectSecrets(path: string, text: string): SecretScan {
  const name = baseName(path)
  if (FILE_WIDE_NAME_PATTERNS.some((re) => re.test(name))) return { fileWide: true, ranges: [], truncated: false }
  const truncated = text.length > MAX_SCAN_CHARS
  const body = truncated ? text.slice(0, MAX_SCAN_CHARS) : text
  if (PRIVATE_KEY_BLOCK_RE.test(body)) return { fileWide: true, ranges: [], truncated }
  const found: SecretRange[] = []
  scanTokens(body, found)
  scanConnectionStrings(body, found)
  scanLines(body, isEnvFile(name), found)
  return { fileWide: false, ranges: normalize(found), truncated }
}
