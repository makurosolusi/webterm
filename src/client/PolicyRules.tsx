// Rules of Settings › Rules & secrets: the rule list (`/api/policy/grants`) in plain words, with the stored
// patterns in a tooltip, a per-rule effect switch and Revoke; above it, "Always allow / Always block" rules made in
// one click from recent approval prompts (PolicyQuickRules), like Claude Code's /permissions growing its
// allow-list from the prompts you answered. The raw pattern form lives under Advanced (PolicyRuleForm).
// The server only accepts these writes from a same-origin page (K4), so only this page can make a rule last forever.
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Segmented } from './centralSettings.controls'
import { PolicyQuickRules } from './PolicyQuickRules'
import { isGrants, policyRequest, POLICY_GRANTS_PATH, RULES_CHANGED_EVENT, type PolicyGrant } from './policyRules.api'
import { rawRuleText, whatText, whereText, whoText } from './policyPresets'

export { POLICY_GRANTS_PATH, type PolicyGrant } from './policyRules.api'

export const POLICY_TEXT = {
  title: 'Rules',
  intro: 'Rules decide what agents may do without asking you. When rules overlap, the newest one counts. Only this page can make a rule last forever.',
  loading: 'Loading rules…',
  loadFailed: 'Cannot load rules.',
  ledgerOff: 'Rules are unavailable while the ledger is off.',
  empty: 'No rules yet.',
  revoke: 'Revoke', revoking: 'Revoking…', revoked: 'Revoked', permanent: 'Forever',
  rowEffect: (rule: string) => `Effect for ${rule}`,
  expires: (at: number) => `until ${new Date(at).toLocaleString()}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
  change: 'Change',
} as const

const EFFECTS = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }] as const

export const ruleText = (g: Pick<PolicyGrant, 'subject' | 'capability' | 'scope'>): string => `${whoText(g.subject)} → ${whatText(g.capability)} (${whereText(g.scope)})`
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function RuleRow({ g, onChangeEffect, onRevoke }: { g: PolicyGrant; onChangeEffect(effect: PolicyGrant['effect']): void; onRevoke(): Promise<void> }): React.JSX.Element {
  const revoke = useAction(onRevoke, { label: `${POLICY_TEXT.revoke}: ${ruleText(g)}`, success: () => POLICY_TEXT.revoked })
  return (
    <li data-grant={g.id} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="flex-1" title={rawRuleText(g)}>{ruleText(g)}
          <span className="opacity-70"> · {g.expiresAt === null ? POLICY_TEXT.permanent : POLICY_TEXT.expires(g.expiresAt)}</span>
        </span>
        <Segmented label={POLICY_TEXT.rowEffect(ruleText(g))} value={g.effect} options={EFFECTS} onChange={(v) => onChangeEffect(v as PolicyGrant['effect'])} />
        <ActionButton size="sm" variant="secondary" action={revoke} busyLabel={POLICY_TEXT.revoking}>{POLICY_TEXT.revoke}</ActionButton>
      </div>
      <ActionResult action={revoke} />
    </li>
  )
}

export function PolicyRules(): React.JSX.Element {
  const [grants, setGrants] = useState<PolicyGrant[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    policyRequest('GET')
      .then((v) => { if (isGrants(v)) { setGrants(v.grants); setLoadError(null) } else setLoadError(POLICY_TEXT.loadFailed) })
      .catch((err: unknown) => setLoadError(err instanceof Error && err.message === 'ledger_off' ? POLICY_TEXT.ledgerOff : POLICY_TEXT.loadFailed))
  }, [])
  useEffect(load, [load])
  // A rule made anywhere on the page (quick rules, Advanced form, Secrets' Allow) shows up here at once.
  useEffect(() => {
    window.addEventListener(RULES_CHANGED_EVENT, load)
    return () => window.removeEventListener(RULES_CHANGED_EVENT, load)
  }, [load])

  // The server has no update route: a new rule with the same Who/What/Where/expiry and the new effect,
  // then the old one is revoked. Created first, so a failure never leaves the rule missing.
  const changeEffect = async (g: PolicyGrant, effect: PolicyGrant['effect']): Promise<void> => {
    setError(null)
    try {
      await policyRequest('POST', POLICY_GRANTS_PATH, {
        subject: g.subject, capability: g.capability, scope: g.scope, effect, ...(g.expiresAt === null ? {} : { expiresAt: g.expiresAt }),
      })
      await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(g.id)}`)
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.change, why(err))) }
    load()
  }

  const revoke = async (id: string): Promise<void> => {
    await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(id)}`)
    load()
  }

  return (
    <section aria-label={POLICY_TEXT.title} data-testid="policy-rules">
      <h3 className="font-semibold">{POLICY_TEXT.title}</h3>
      <p className="text-xs opacity-70">{POLICY_TEXT.intro}</p>
      {/* Unreadable list = a note like the protection section, not an alert: the rest of the tab still works. */}
      {loadError ? <p className="text-xs opacity-70">{loadError}</p> : null}
      {grants === null && !loadError ? <p role="status" className="text-xs opacity-70">{POLICY_TEXT.loading}</p> : null}
      {grants ? <PolicyQuickRules grants={grants} /> : null}
      {grants?.length === 0 ? <p className="text-xs opacity-70">{POLICY_TEXT.empty}</p> : null}
      {grants && grants.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {grants.map((g) => <RuleRow key={g.id} g={g} onChangeEffect={(e) => { void changeEffect(g, e) }} onRevoke={() => revoke(g.id)} />)}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
