// Policy rules of Settings › Rules & approvals: lists `/api/policy/grants`, creates, re-decides and revokes
// rules. The server only accepts these writes from a same-origin page (K4), so this is the one place where a
// permanent ("Forever") rule can be made; Telegram can only write short-lived rules.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Segmented } from './centralSettings.controls'
import { SettingsSelect } from './SettingsControls'
import { SettingsCombobox } from './SettingsCombobox'
import { CAPABILITY_PRESETS, PREFILL_RULE_EVENT, SCOPE_PRESETS, SUBJECTS, whatText, whereText, whoText, type PrefillRule } from './policyPresets'

export const POLICY_GRANTS_PATH = '/api/policy/grants'
const HOUR_MS = 3_600_000

/** Mirror of the server `Grant` (src/server/policy/policy.model.ts). */
export interface PolicyGrant {
  id: string; subject: string; capability: string; scope: string; effect: 'allow' | 'ask' | 'deny'
  expiresAt: number | null; origin: string; createdBy: string; createdAt: number
}

export const POLICY_TEXT = {
  title: 'Rules',
  intro: 'Rules decide what agents may do without asking you. When rules overlap, the newest one counts. Only this page can make a rule last forever.',
  loading: 'Loading rules…',
  loadFailed: 'Cannot load rules.',
  ledgerOff: 'Rules are unavailable while the ledger is off.',
  empty: 'No rules yet.',
  subject: 'Who', capability: 'What', scope: 'Where',
  effect: 'Effect', duration: 'How long', add: 'Add rule', revoke: 'Revoke', permanent: 'Forever',
  rowEffect: (rule: string) => `Effect for ${rule}`,
  expires: (at: number) => `until ${new Date(at).toLocaleString()}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
  change: 'Change',
} as const

const DURATIONS = [
  { value: '1h', label: '1 hour', ms: HOUR_MS },
  { value: '1d', label: '1 day', ms: 24 * HOUR_MS },
  { value: 'forever', label: 'Forever', ms: null },
] as const
const EFFECTS = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }] as const

/** Fetch (the session cookie rides along); throws with the server's error code (or the status) on failure. */
async function policyRequest(method: string, path = POLICY_GRANTS_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const isGrants = (v: unknown): v is { grants: PolicyGrant[] } => !!v && Array.isArray((v as { grants?: unknown }).grants)
const ruleText = (g: Pick<PolicyGrant, 'subject' | 'capability' | 'scope'>): string => `${whoText(g.subject)} → ${whatText(g.capability)} (${whereText(g.scope)})`
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function PolicyRules({ now = Date.now }: { now?: () => number }): React.JSX.Element {
  const [grants, setGrants] = useState<PolicyGrant[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ subject: 'node:*', capability: '', scope: '*', effect: 'allow' as PolicyGrant['effect'], duration: '1h' })

  const load = useCallback(() => {
    policyRequest('GET')
      .then((v) => { if (isGrants(v)) { setGrants(v.grants); setLoadError(null) } else setLoadError(POLICY_TEXT.loadFailed) })
      .catch((err: unknown) => setLoadError(err instanceof Error && err.message === 'ledger_off' ? POLICY_TEXT.ledgerOff : POLICY_TEXT.loadFailed))
  }, [])
  useEffect(load, [load])

  // Another panel (Secrets' "Allow an agent to use this") pre-fills What and Where; Who and Effect stay the user's call.
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<PrefillRule>).detail
      if (d) setForm((f) => ({ ...f, capability: d.capability, scope: d.scope }))
    }
    window.addEventListener(PREFILL_RULE_EVENT, on)
    return () => window.removeEventListener(PREFILL_RULE_EVENT, on)
  }, [])

  const add = async (): Promise<void> => {
    const ms = (DURATIONS.find((d) => d.value === form.duration) ?? DURATIONS[0]).ms // null = Forever
    setError(null)
    try {
      await policyRequest('POST', POLICY_GRANTS_PATH, {
        subject: form.subject.trim(), capability: form.capability.trim(), scope: form.scope.trim() || '*', effect: form.effect,
        ...(ms === null ? {} : { expiresAt: now() + ms }),
      })
      load()
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.add, why(err))) }
  }

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
    setError(null)
    try {
      await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(id)}`)
      load()
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.revoke, why(err))) }
  }

  const combo = (key: 'capability' | 'scope', presets: typeof CAPABILITY_PRESETS) => (
    <span className="w-56">
      <SettingsCombobox ariaLabel={POLICY_TEXT[key]} fieldId={`policy.${key}`} mono presets={presets} placeholder={POLICY_TEXT[key]}
        value={form[key]} onDraft={(v) => setForm((f) => ({ ...f, [key]: v }))} onCommit={(v) => setForm((f) => ({ ...f, [key]: v }))} />
    </span>
  )

  return (
    <section aria-label={POLICY_TEXT.title} data-testid="policy-rules">
      <h3 className="font-semibold">{POLICY_TEXT.title}</h3>
      <p className="text-xs opacity-70">{POLICY_TEXT.intro}</p>
      {/* Unreadable list = a note like the protection section, not an alert: the rest of the tab still works. */}
      {loadError ? <p className="text-xs opacity-70">{loadError}</p> : null}
      {grants === null && !loadError ? <p role="status" className="text-xs opacity-70">{POLICY_TEXT.loading}</p> : null}
      {grants?.length === 0 ? <p className="text-xs opacity-70">{POLICY_TEXT.empty}</p> : null}
      {grants && grants.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {grants.map((g) => (
            <li key={g.id} data-grant={g.id} className="flex items-center gap-2">
              <span className="flex-1">{ruleText(g)}
                <span className="opacity-70"> · {g.expiresAt === null ? POLICY_TEXT.permanent : POLICY_TEXT.expires(g.expiresAt)}</span>
              </span>
              <Segmented label={POLICY_TEXT.rowEffect(ruleText(g))} value={g.effect} options={EFFECTS}
                onChange={(v) => { void changeEffect(g, v as PolicyGrant['effect']) }} />
              <Button size="sm" variant="secondary" onClick={() => void revoke(g.id)}>{POLICY_TEXT.revoke}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {grants ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="policy-add-rule">
          <SettingsSelect ariaLabel={POLICY_TEXT.subject} value={form.subject} options={SUBJECTS} onChange={(v) => setForm((f) => ({ ...f, subject: v }))} />
          {combo('capability', CAPABILITY_PRESETS)}{combo('scope', SCOPE_PRESETS)}
          <Segmented label={POLICY_TEXT.effect} value={form.effect} options={EFFECTS} onChange={(v) => setForm((f) => ({ ...f, effect: v as PolicyGrant['effect'] }))} />
          <Segmented label={POLICY_TEXT.duration} value={form.duration} options={DURATIONS} onChange={(v) => setForm((f) => ({ ...f, duration: v }))} />
          <Button size="sm" onClick={() => void add()} disabled={form.subject.trim() === '' || form.capability.trim() === ''}>{POLICY_TEXT.add}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
