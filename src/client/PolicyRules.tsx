// Rules of Settings › Rules & secrets: the rule list (`/api/policy/grants`) in plain words, with the stored
// patterns in a tooltip, a per-rule effect switch and Revoke; then "Always allow / Always block" rules made in
// one click from recent approval prompts (PolicyQuickRules), like Claude Code's /permissions growing its
// allow-list from the prompts you answered. The "Add a rule" form below them is PolicyRuleForm.
// The server only accepts these writes from a same-origin page (K4), so only this page can make a rule last forever.
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { CardEmpty, CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup, SettingsSegmented } from './SettingsControls'
import { SafeguardNote } from './SettingsFields'
import { PolicyQuickRules } from './PolicyQuickRules'
import { RULE_FORM_WHAT_ID } from './PolicyRuleForm'
import { isGrants, policyRequest, POLICY_GRANTS_PATH, RULES_CHANGED_EVENT, type PolicyGrant } from './policyRules.api'
import { RULE_EFFECTS, rawRuleText, whatText, whereText, whoText } from './policyPresets'

export { POLICY_GRANTS_PATH, type PolicyGrant } from './policyRules.api'

export const POLICY_TEXT = {
  title: 'Rules',
  intro: 'Rules decide what agents may do without asking you. When rules overlap, the newest one counts. Only this page can make a rule last forever.',
  loading: 'Loading rules…',
  loadFailed: 'Could not load the rules.',
  ledgerOff: 'Rules are unavailable while the activity log is off.',
  empty: 'No rules yet. Agents ask you before each action until you add one.',
  addFirst: 'Add a rule',
  revoke: 'Revoke', revoking: 'Revoking…', revoked: 'Revoked', permanent: 'Forever',
  rowEffect: (rule: string) => `Effect for ${rule}`,
  expires: (at: number) => `Until ${new Date(at).toLocaleString()}`,
  removedWorkspace: 'a removed workspace',
  failed: (what: string, why: string) => `${what} failed: ${why}`,
  change: 'Change',
} as const

/** Workspace id -> name, for "in <workspace>" on a workspace-limited rule. */
export type WorkspaceNames = ReadonlyMap<string, string>

export const ruleText = (g: Pick<PolicyGrant, 'subject' | 'capability' | 'scope' | 'workspaceId'>, names?: WorkspaceNames): string =>
  `${whoText(g.subject)}${g.workspaceId ? ` in ${names?.get(g.workspaceId) ?? POLICY_TEXT.removedWorkspace}` : ''} → ${whatText(g.capability)} (${whereText(g.scope)})`
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function RuleRow({ g, names, onChangeEffect, onRevoke }: { g: PolicyGrant; names?: WorkspaceNames; onChangeEffect(effect: PolicyGrant['effect']): void; onRevoke(): Promise<void> }): React.JSX.Element {
  const text = ruleText(g, names)
  const revoke = useAction(onRevoke, { label: `${POLICY_TEXT.revoke}: ${text}`, success: () => POLICY_TEXT.revoked })
  return (
    <li data-grant={g.id} className="st-field">
      <div className="st-field-text">
        <span className="st-row-title" title={rawRuleText(g)}>{text}</span>
        <p className="st-row-meta">{g.expiresAt === null ? POLICY_TEXT.permanent : POLICY_TEXT.expires(g.expiresAt)}</p>
        <ActionResult action={revoke} />
      </div>
      <div className="st-control">
        <SettingsSegmented ariaLabel={POLICY_TEXT.rowEffect(text)} value={g.effect} options={RULE_EFFECTS} onChange={onChangeEffect} />
        <ActionButton size="sm" variant="outline" action={revoke} busyLabel={POLICY_TEXT.revoking}>{POLICY_TEXT.revoke}</ActionButton>
      </div>
    </li>
  )
}

type Load = { state: 'loading' } | { state: 'failed'; text: string; retry: boolean } | { state: 'ready'; grants: PolicyGrant[] }

export function PolicyRules({ workspaceNames }: { workspaceNames?: WorkspaceNames } = {}): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    policyRequest('GET')
      .then((v) => setLoad(isGrants(v) ? { state: 'ready', grants: v.grants } : { state: 'failed', text: POLICY_TEXT.loadFailed, retry: true }))
      .catch((err: unknown) => setLoad(err instanceof Error && err.message === 'ledger_off'
        ? { state: 'failed', text: POLICY_TEXT.ledgerOff, retry: false }
        : { state: 'failed', text: POLICY_TEXT.loadFailed, retry: true }))
  }, [])
  useEffect(reload, [reload])
  // A rule made anywhere on the page (quick rules, the form, Secrets' Allow) shows up here at once.
  useEffect(() => {
    window.addEventListener(RULES_CHANGED_EVENT, reload)
    return () => window.removeEventListener(RULES_CHANGED_EVENT, reload)
  }, [reload])

  // The server has no update route: a new rule with the same Who/What/Where/expiry and the new effect,
  // then the old one is revoked. Created first, so a failure never leaves the rule missing.
  const changeEffect = async (g: PolicyGrant, effect: PolicyGrant['effect']): Promise<void> => {
    setError(null)
    try {
      await policyRequest('POST', POLICY_GRANTS_PATH, {
        subject: g.subject, capability: g.capability, scope: g.scope, effect, ...(g.expiresAt === null ? {} : { expiresAt: g.expiresAt }),
        ...(g.workspaceId ? { workspaceId: g.workspaceId } : {}),
      })
      await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(g.id)}`)
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.change, why(err))) }
    reload()
  }

  const revoke = async (id: string): Promise<void> => {
    await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(id)}`)
    reload()
  }
  const grants = load.state === 'ready' ? load.grants : null

  return (
    <div data-testid="policy-rules" className="contents">
      <SettingsGroup title={POLICY_TEXT.title} description={POLICY_TEXT.intro}>
        <div className="st-state"><SafeguardNote id="denyRules" /></div>
        {load.state === 'loading' ? <CardLoading text={POLICY_TEXT.loading} /> : null}
        {/* Unreadable list: the reason (+ Retry) in the card; the rest of the page still works. */}
        {load.state === 'failed' ? <CardError text={load.text} onRetry={load.retry ? reload : undefined} /> : null}
        {grants?.length === 0 ? (
          <CardEmpty text={POLICY_TEXT.empty}>
            <Button size="sm" variant="outline" onClick={() => document.getElementById(RULE_FORM_WHAT_ID)?.focus()}>{POLICY_TEXT.addFirst}</Button>
          </CardEmpty>
        ) : null}
        {grants && grants.length > 0 ? (
          <ul className="st-list" aria-label={POLICY_TEXT.title}>
            {grants.map((g) => <RuleRow key={g.id} g={g} names={workspaceNames} onChangeEffect={(e) => { void changeEffect(g, e) }} onRevoke={() => revoke(g.id)} />)}
          </ul>
        ) : null}
        {error ? <p role="alert" className="st-state st-state--error">{error}</p> : null}
      </SettingsGroup>
      {grants ? <PolicyQuickRules grants={grants} /> : null}
    </div>
  )
}
