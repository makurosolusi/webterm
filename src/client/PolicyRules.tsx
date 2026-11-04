// Policy rules section of Settings › Control: lists `/api/policy/grants`, creates and revokes rules.
// The server only accepts these writes from a same-origin page (K4), so this is the one place where a
// permanent ("Forever") rule can be made; Telegram can only write short-lived rules.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'

export const POLICY_GRANTS_PATH = '/api/policy/grants'
const HOUR_MS = 3_600_000

/** Mirror of the server `Grant` (src/server/policy/policy.model.ts). */
export interface PolicyGrant {
  id: string; subject: string; capability: string; scope: string; effect: 'allow' | 'ask' | 'deny'
  expiresAt: number | null; origin: string; createdBy: string; createdAt: number
}

export const POLICY_TEXT = {
  title: 'Policy rules',
  intro: 'Rules decide what agents may do. The last matching rule wins; `*` matches anything. Only this page can make a rule permanent.',
  loading: 'Loading rules…',
  loadFailed: 'Cannot load policy rules.',
  ledgerOff: 'Policy rules are unavailable while the ledger is off.',
  empty: 'No rules yet.',
  subject: 'Who (e.g. node:*)', capability: 'Capability (e.g. browser.*)', scope: 'Scope (e.g. *)',
  effect: 'Effect', duration: 'Duration', add: 'Add rule', revoke: 'Revoke', permanent: 'Permanent',
  expires: (at: number) => `until ${new Date(at).toLocaleString()}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const

const DURATIONS = [
  { id: '1h', label: '1 hour', ms: HOUR_MS },
  { id: '1d', label: '1 day', ms: 24 * HOUR_MS },
  { id: 'forever', label: 'Forever', ms: null },
] as const
const EFFECTS = ['allow', 'ask', 'deny'] as const
const BADGE = { allow: 'secondary', ask: 'outline', deny: 'destructive' } as const

/** Fetch with the transport token; throws with the server's error code (or the status) on failure. */
async function policyRequest(method: string, path = POLICY_GRANTS_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const isGrants = (v: unknown): v is { grants: PolicyGrant[] } => !!v && Array.isArray((v as { grants?: unknown }).grants)

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

  const add = async (): Promise<void> => {
    const ms = (DURATIONS.find((d) => d.id === form.duration) ?? DURATIONS[0]).ms // null = Forever
    setError(null)
    try {
      await policyRequest('POST', POLICY_GRANTS_PATH, {
        subject: form.subject.trim(), capability: form.capability.trim(), scope: form.scope.trim() || '*', effect: form.effect,
        ...(ms === null ? {} : { expiresAt: now() + ms }),
      })
      load()
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.add, err instanceof Error ? err.message : String(err))) }
  }

  const revoke = async (id: string): Promise<void> => {
    setError(null)
    try {
      await policyRequest('DELETE', `${POLICY_GRANTS_PATH}/${encodeURIComponent(id)}`)
      load()
    } catch (err) { setError(POLICY_TEXT.failed(POLICY_TEXT.revoke, err instanceof Error ? err.message : String(err))) }
  }

  const field = (key: 'subject' | 'capability' | 'scope') => (
    <Input aria-label={POLICY_TEXT[key]} placeholder={POLICY_TEXT[key]} value={form[key]}
      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="min-w-32 flex-1" />
  )

  // Segmented buttons (shadcn Button, aria-pressed): the project bans raw form controls (shadcnPolicy.test.ts).
  const choice = (label: string, options: readonly { id: string; label: string }[], value: string, pick: (id: string) => void) => (
    <span role="group" aria-label={label} className="flex gap-1">
      {options.map((o) => (
        <Button key={o.id} size="sm" variant={o.id === value ? 'default' : 'outline'} aria-pressed={o.id === value} onClick={() => pick(o.id)}>{o.label}</Button>
      ))}
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
              <Badge variant={BADGE[g.effect]} className="min-w-12 justify-center">{g.effect}</Badge>
              <span className="flex-1"><code>{g.subject}</code> → <code>{g.capability}</code> on <code>{g.scope}</code>
                <span className="opacity-70"> · {g.expiresAt === null ? POLICY_TEXT.permanent : POLICY_TEXT.expires(g.expiresAt)} · {g.origin}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void revoke(g.id)}>{POLICY_TEXT.revoke}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {grants ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {field('subject')}{field('capability')}{field('scope')}
          {choice(POLICY_TEXT.effect, EFFECTS.map((e) => ({ id: e, label: e })), form.effect, (id) => setForm((f) => ({ ...f, effect: id as PolicyGrant['effect'] })))}
          {choice(POLICY_TEXT.duration, DURATIONS, form.duration, (id) => setForm((f) => ({ ...f, duration: id })))}
          <Button size="sm" onClick={() => void add()} disabled={form.subject.trim() === '' || form.capability.trim() === ''}>{POLICY_TEXT.add}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
