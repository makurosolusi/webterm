// Source scan for the repo-wide tooltip policy (next wave): icon-only controls must go through
// IconButton / IconTooltip, never a native `title` (slow, unstyled) or a bare `size="icon*"` Button.

export interface TooltipPolicyViolation {
  line: number
  reason: 'native-title' | 'bare-icon-button'
  snippet: string
}

// Opening tag of <button>/<Button>; `=>` inside attribute expressions does not end the tag.
const OPENING_TAG = /<(button|Button)\b(?:=>|[^>])*>/g

/** Violations in one .tsx source: `title=` on a button tag, or `<Button size="icon…">` outside IconButton. */
export function findTooltipPolicyViolations(source: string): TooltipPolicyViolation[] {
  const out: TooltipPolicyViolation[] = []
  for (const m of source.matchAll(OPENING_TAG)) {
    const tag = m[0]
    const line = source.slice(0, m.index).split('\n').length
    const snippet = tag.split('\n')[0]
    if (/\stitle=/.test(tag)) out.push({ line, reason: 'native-title', snippet })
    if (m[1] === 'Button' && /\ssize=["']icon/.test(tag)) out.push({ line, reason: 'bare-icon-button', snippet })
  }
  return out
}
