// "From recent approvals" in Settings › Rules & secrets: the last Claude permission prompts (any answer) that no
// rule covers yet, each with one-click "Always allow" / "Always block" (a permanent rule for any agent, same
// pattern the prompt card's "Always allow" saves), like Claude Code /permissions growing from the prompts.
import { useEffect, useRef, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { SettingsGroup } from './SettingsControls'
import { createRule, isAsks, policyRequest, RECENT_ASKS_PATH, type PolicyGrant, type RecentAsk } from './policyRules.api'
import { TOOL_PREFIX } from './policyPresets'

export const QUICK_RULES_TEXT = {
  title: 'From recent approvals',
  intro: 'Things agents asked you about lately. Make a rule so they never ask again.',
  allow: 'Always allow', block: 'Always block', saving: 'Saving…',
  allowed: 'Now always allowed', blocked: 'Now always blocked',
  askedBy: (node: string) => `asked by ${node}`,
} as const
const T = QUICK_RULES_TEXT

const capabilityOf = (a: RecentAsk): string => `${TOOL_PREFIX}${a.tool}`
/** True when a rule already decides exactly this tool + pattern (the ask would not come back). */
const covered = (grants: readonly PolicyGrant[], a: RecentAsk): boolean =>
  grants.some((g) => g.capability === capabilityOf(a) && g.scope === a.pattern && g.effect !== 'ask')

function AskRow({ ask }: { ask: RecentAsk }): React.JSX.Element {
  const rule = (effect: 'allow' | 'deny') => () => createRule({ subject: 'node:*', capability: capabilityOf(ask), scope: ask.pattern, effect })
  const allow = useAction(rule('allow'), { label: `${T.allow}: ${ask.label}`, success: () => T.allowed, toast: 'always' })
  const block = useAction(rule('deny'), { label: `${T.block}: ${ask.label}`, success: () => T.blocked, toast: 'always' })
  return (
    <li data-ask={`${ask.tool}:${ask.pattern}`} className="st-field">
      <div className="st-field-text">
        <code className="st-row-title">{ask.label}</code>
        <p className="st-row-meta">{T.askedBy(ask.node)}</p>
        <ActionResult action={allow} />
        <ActionResult action={block} />
      </div>
      <div className="st-control">
        <ActionButton size="sm" variant="outline" action={allow} busyLabel={T.saving}>{T.allow}</ActionButton>
        <ActionButton size="sm" variant="outline" action={block} busyLabel={T.saving}>{T.block}</ActionButton>
      </div>
    </li>
  )
}

/** Hidden when nothing was asked lately, or the ledger is off (the rule list says so). */
export function PolicyQuickRules({ grants }: { grants: readonly PolicyGrant[] }): React.JSX.Element | null {
  const [asks, setAsks] = useState<RecentAsk[] | null>(null)
  // Filtered against the rules once, when the asks arrive: a row you just turned into a rule stays, showing its result.
  const rules = useRef(grants)
  rules.current = grants
  useEffect(() => {
    policyRequest('GET', RECENT_ASKS_PATH).then((v) => setAsks(isAsks(v) ? v.items.filter((a) => !covered(rules.current, a)) : null)).catch(() => setAsks(null))
  }, [])
  const open = asks ?? []
  if (open.length === 0) return null
  return (
    <div data-testid="policy-quick-rules" className="contents">
      <SettingsGroup title={T.title} description={T.intro}>
        <ul className="st-list" aria-label={T.title}>{open.map((a) => <AskRow key={`${a.tool}:${a.pattern}`} ask={a} />)}</ul>
      </SettingsGroup>
    </div>
  )
}
