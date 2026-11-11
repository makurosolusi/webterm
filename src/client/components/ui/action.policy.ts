// Source scan for action feedback (actionFeedbackPolicy.test.ts):
// 1. async-click: an async handler wired straight to a click/check (`onClick={async`, `onClick={() => void x()}`,
//    `onClick={x}` with x a local async/Promise function, `onCheckedChange={(v) => void`) gives no busy state
//    and swallows the result; go through useAction + ActionButton instead.
// 2. In settings screens, a disabled control must say why: `disabled={…}` only on busy state, or with
//    `lock=` / `disabledReason=` / an IconTooltip around it; and `hint={c ? A : B}` beside `disabled=`
//    (the description swapped for the reason) is flagged: the hint stays, the reason goes in `lock`.

export interface ActionPolicyViolation {
  line: number
  reason: 'async-click' | 'disabled-no-reason' | 'hint-swap'
  snippet: string
}

// Opening tag; `=>` inside attribute expressions does not end the tag (same approach as icon-button.policy).
const OPENING_TAG = /<([A-Z][\w.]*|button|input|select)\b(?:=>|[^>])*>/g
const TOOLTIP_WRAPPER = /<IconTooltip\b(?:=>|[^>])*>\s*$/
const BUSY_NAME = /busy|working|saving|testing|pending|checking|running|connecting/i
const DISABLE_TAGS = /^(?:Button|Switch|Checkbox|SettingsSelect|SettingsCheckbox|\w+Field)$/
const SETTINGS_FILE = /(?:^|\/)(?:Settings\w*|Central\w*|Capabilit\w*|ClaudeProvider\w*|ControlPanel\w*|SecretsPanel|PolicyRules)\.tsx$|(?:^|\/)(?:claudeLauncher|setup|workspaceCreate)\//

/** Settings-related client file (path relative to src/client, or the repo), where rule 2 applies. */
export const isSettingsFile = (rel: string): boolean => SETTINGS_FILE.test(rel.replace(/\\/g, '/'))

/** Names of functions declared async or returning a Promise in this file. */
function asyncNames(source: string): Set<string> {
  const names = new Set<string>()
  const patterns = [
    /\basync\s+function\s+(\w+)/g,
    /\b(?:const|let)\s+(\w+)\s*=\s*(?:useCallback\(\s*)?async\b/g,
    /\b(?:const|let)\s+(\w+)\s*=\s*(?:useCallback\(\s*)?\([^)]*\)\s*:\s*Promise</g,
    /\bfunction\s+(\w+)\s*\([^)]*\)\s*:\s*Promise</g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) names.add(m[1])
  return names
}

/** The `{…}` expression of attribute `name` in a tag, braces balanced, or null. */
function attr(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\s${name}=\\{`))
  if (at < 0) return null
  const start = tag.indexOf('{', at)
  let depth = 0
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === '{') depth++
    else if (tag[i] === '}' && --depth === 0) return tag.slice(start + 1, i).trim()
  }
  return null
}

/** True when every identifier path in `expr` ends in a busy name (a running action explains itself). */
const onlyBusy = (expr: string): boolean => {
  const paths = (expr.match(/[A-Za-z_$][\w$.]*/g) ?? []).filter((p) => !/^(?:true|false|null|undefined)$/.test(p))
  return paths.every((p) => BUSY_NAME.test(p.split('.').pop() ?? ''))
}

/** Violations in one .tsx source; `settings` turns on rule 2. */
export function findActionPolicyViolations(source: string, settings: boolean): ActionPolicyViolation[] {
  const out: ActionPolicyViolation[] = []
  const asyncFns = asyncNames(source)
  for (const m of source.matchAll(OPENING_TAG)) {
    const tag = m[0]
    const name = m[1]
    const line = source.slice(0, m.index).split('\n').length
    const snippet = tag.split('\n')[0]
    const push = (reason: ActionPolicyViolation['reason']): void => { out.push({ line, reason, snippet }) }
    if (name !== 'ActionButton') {
      const click = attr(tag, 'onClick')
      const checked = attr(tag, 'onCheckedChange')
      if (click !== null && (/^async\b/.test(click) || /^\([^)]*\)\s*=>\s*\{?\s*void\s/.test(click) || asyncFns.has(click))) push('async-click')
      else if (checked !== null && /^\([^)]*\)\s*=>\s*\{?\s*void\s/.test(checked)) push('async-click')
    }
    if (!settings || !DISABLE_TAGS.test(name)) continue
    const disabled = attr(tag, 'disabled')
    if (disabled !== null && /\?(?![.?])/.test(attr(tag, 'hint') ?? '')) push('hint-swap')
    if (disabled === null || onlyBusy(disabled) || /\s(?:lock|disabledReason|describedBy|aria-describedby)=/.test(tag)) continue
    if (TOOLTIP_WRAPPER.test(source.slice(Math.max(0, m.index - 2000), m.index))) continue
    push('disabled-no-reason')
  }
  return out
}
