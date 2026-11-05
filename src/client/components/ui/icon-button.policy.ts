// Source scan for the repo-wide tooltip policy: icon-only controls must go through
// IconButton / IconTooltip, never a native `title` (slow, unstyled), a bare `size="icon*"`
// Button, or a `<button>` holding nothing but a glyph with no visible hint at all.

export interface TooltipPolicyViolation {
  line: number
  reason: 'native-title' | 'bare-icon-button' | 'icon-only-button'
  snippet: string
}

// Opening tag of <button>/<Button>; `=>` inside attribute expressions does not end the tag.
const OPENING_TAG = /<(button|Button)\b(?:=>|[^>])*>/g
// Wrappers that give their single child a visible tooltip. VscodeTooltip is the older VS Code
// layer primitive (output toolbar, timeline) and also renders a real hover, so it counts.
const TOOLTIP_WRAPPER = /<(?:IconTooltip|VscodeTooltip)\b(?:=>|[^>])*>\s*$/

/** Children that render only a glyph: `{codicon(...)}`, codicon spans, svg, `<XxxIcon/>`, lucide imports. */
function iconOnly(children: string, lucide: Set<string>): boolean {
  let rest = children
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\{\s*codicon\((?:[^()]|\([^()]*\))*\)\s*\}/g, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/g, '')
    .replace(/<span\b(?:=>|[^>])*\bcodicon\b(?:=>|[^>])*?(?:\/>|>\s*<\/span>)/g, '')
    .replace(/<([A-Z]\w*)\b(?:=>|[^>])*?\/>/g, (tag, name: string) => (name.endsWith('Icon') || lucide.has(name) ? '' : tag))
  // Wrappers left empty once their glyph is gone (e.g. `<span className="x__icon">{codicon(..)}</span>`).
  for (let prev = ''; prev !== rest; ) {
    prev = rest
    rest = rest.replace(/<(span|i|div)\b(?:=>|[^>])*>\s*<\/\1>/g, '')
  }
  return rest.trim() === '' && rest !== children
}

/** Violations in one .tsx source: `title=` on a button tag, a bare `<Button size="icon…">`, or an untooltipped icon-only button. */
export function findTooltipPolicyViolations(source: string): TooltipPolicyViolation[] {
  const out: TooltipPolicyViolation[] = []
  const lucide = new Set<string>()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()
      if (name) lucide.add(name)
    }
  }
  for (const m of source.matchAll(OPENING_TAG)) {
    const tag = m[0]
    const start = m.index
    const line = source.slice(0, start).split('\n').length
    const snippet = tag.split('\n')[0]
    if (/\stitle=/.test(tag)) out.push({ line, reason: 'native-title', snippet })
    const bare = m[1] === 'Button' && /\ssize=["']icon/.test(tag)
    if (bare) out.push({ line, reason: 'bare-icon-button', snippet })
    if (bare || tag.endsWith('/>')) continue
    // Buttons cannot nest, so the next closing tag of the same name ends this one.
    const close = source.indexOf(`</${m[1]}>`, start + tag.length)
    if (close < 0 || !iconOnly(source.slice(start + tag.length, close), lucide)) continue
    if (TOOLTIP_WRAPPER.test(source.slice(Math.max(0, start - 2000), start))) continue
    out.push({ line, reason: 'icon-only-button', snippet })
  }
  return out
}
