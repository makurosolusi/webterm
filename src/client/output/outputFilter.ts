// Output-panel filter syntax (VS Code): comma-separated terms, `!term` excludes, `\` escapes the
// next character (so `\,` and `\!` are literal). Matching is case-insensitive substring.

export interface ParsedFilter {
  include: string[]
  exclude: string[]
}

/** Split on commas that are not escaped; backslashes are kept for `unescape` to resolve. */
function splitTerms(text: string): string[] {
  const terms: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1]
      i += 1
    } else if (ch === ',') {
      terms.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  terms.push(current)
  return terms
}

const unescape = (raw: string): string => raw.replace(/\\(.)/g, '$1')

/** Parse the filter box text; empty terms are dropped. */
export function parseFilter(text: string): ParsedFilter {
  const include: string[] = []
  const exclude: string[] = []
  for (const part of splitTerms(text)) {
    const raw = part.trim()
    const negated = raw.startsWith('!')
    const term = unescape(negated ? raw.slice(1).trim() : raw).toLowerCase()
    if (term === '') continue
    ;(negated ? exclude : include).push(term)
  }
  return { include, exclude }
}

/** True when no exclude term occurs and (there are no include terms or one occurs). */
export function matchesFilter(filter: ParsedFilter, haystack: string): boolean {
  const lower = haystack.toLowerCase()
  if (filter.exclude.some((term) => lower.includes(term))) return false
  return filter.include.length === 0 || filter.include.some((term) => lower.includes(term))
}

/** Escape a literal so it matches itself as a single filter term (used by id chips). */
export function escapeFilterTerm(value: string): string {
  return value.replace(/[\\,!]/g, '\\$&')
}
