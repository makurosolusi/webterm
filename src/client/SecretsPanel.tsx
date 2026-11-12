// Secrets part of Settings › Rules & secrets: the secret broker's names, add/replace, delete and usage log
// (`/api/secrets`, UI-only on the server). Values go out once on save and never come back: like a
// password manager field, the list shows names only and the input is cleared after a save.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { secretRule, whoText } from './policyPresets'
import { createRule } from './policyRules.api'
import { SafeguardNote } from './SettingsFields'

export const SECRETS_PATH = '/api/secrets'

export interface SecretEntry { name: string; lastUsedAt: number | null }
export interface SecretUse { seq: number; ts: number; name: string; principal: string; commandHash: string; exitCode: number | null }
interface SecretsView { secrets: SecretEntry[]; usage: SecretUse[] | null }

export const SECRETS_TEXT = {
  title: 'Secrets',
  intro: 'Agents ask before using a secret, unless you allow it here.',
  detail: 'An agent never sees the value: it goes into one command and is hidden in that command\'s output.',
  loading: 'Loading secrets…',
  loadFailed: 'Cannot load secrets.',
  empty: 'No secrets yet.',
  name: 'Name (e.g. NPM_TOKEN)', value: 'Value', save: 'Save', delete: 'Delete',
  allow: (ws: string) => `Allow for agents in ${ws}`, allowNoWorkspace: 'Allow agents to use this', allowing: 'Allowing…',
  allowed: (name: string, ws: string) => `${name}: allowed for agents in ${ws}. Revoke it under Rules.`,
  noWorkspace: 'Open a workspace first: the rule is for the agents in it.',
  neverUsed: 'never used', lastUsed: (at: number) => `last used ${new Date(at).toLocaleString()}`,
  colWhen: 'When', colName: 'Secret', colWho: 'Used by', colCommand: 'Command', colResult: 'Result',
  ok: 'OK', exitFailed: (code: number) => `Failed (exit ${code})`, noResult: 'Unknown',
  usageTitle: 'Usage log', usageEmpty: 'No uses yet.', usageOff: 'The usage log is unavailable while the ledger is off.',
  failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

async function secretsRequest(method: string, path = SECRETS_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const isView = (v: unknown): v is SecretsView => !!v && Array.isArray((v as SecretsView).secrets)

/** The workspace the user is in: an Allow is for the agents on it only. */
export interface SecretsWorkspace { id: string; name: string }

/** "Allow for agents in <workspace>": makes the rule (agents of the current workspace, any command, forever) right here, with its result. */
function AllowSecret({ name, workspace }: { name: string; workspace: SecretsWorkspace | null }): React.JSX.Element {
  const allow = useAction(async () => {
    if (!workspace) throw new Error(SECRETS_TEXT.noWorkspace) // the button is locked then; guards a stale click
    await createRule({ subject: 'node:*', ...secretRule(name), workspaceId: workspace.id, effect: 'allow' })
  }, { label: `${workspace ? SECRETS_TEXT.allow(workspace.name) : SECRETS_TEXT.allowNoWorkspace}: ${name}`, success: () => SECRETS_TEXT.allowed(name, workspace?.name ?? ''), toast: 'always' })
  return (
    <span className="flex flex-col gap-0.5">
      <ActionButton size="sm" variant="outline" action={allow} busyLabel={SECRETS_TEXT.allowing} lock={workspace ? undefined : { reason: SECRETS_TEXT.noWorkspace }}>
        {workspace ? SECRETS_TEXT.allow(workspace.name) : SECRETS_TEXT.allowNoWorkspace}
      </ActionButton>
      <ActionResult action={allow} />
    </span>
  )
}

export function SecretsPanel({ workspace = null }: { workspace?: SecretsWorkspace | null }): React.JSX.Element {
  const [view, setView] = useState<SecretsView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  const load = useCallback(() => {
    secretsRequest('GET')
      .then((v) => { if (isView(v)) { setView(v); setLoadError(false) } else setLoadError(true) })
      .catch(() => setLoadError(true)) // shown as the loadFailed note
  }, [])
  useEffect(load, [load])

  const save = async (): Promise<void> => {
    setError(null)
    try {
      await secretsRequest('PUT', `${SECRETS_PATH}/${encodeURIComponent(name.trim())}`, { value })
      setValue('')
      load()
    } catch (err) { setError(SECRETS_TEXT.failed(SECRETS_TEXT.save, err instanceof Error ? err.message : String(err))) }
  }

  const remove = async (n: string): Promise<void> => {
    setError(null)
    try {
      await secretsRequest('DELETE', `${SECRETS_PATH}/${encodeURIComponent(n)}`)
      load()
    } catch (err) { setError(SECRETS_TEXT.failed(SECRETS_TEXT.delete, err instanceof Error ? err.message : String(err))) }
  }

  return (
    <section aria-label={SECRETS_TEXT.title} data-testid="secrets-panel">
      <h3 className="font-semibold">{SECRETS_TEXT.title}</h3>
      <p className="text-xs opacity-70">{SECRETS_TEXT.intro}</p>
      <SafeguardNote id="secretAccess" />
      <p className="text-xs opacity-70">{SECRETS_TEXT.detail}</p>
      {loadError ? <p className="text-xs opacity-70">{SECRETS_TEXT.loadFailed}</p> : null}
      {!view && !loadError ? <p role="status" className="text-xs opacity-70">{SECRETS_TEXT.loading}</p> : null}
      {view?.secrets.length === 0 ? <p className="text-xs opacity-70">{SECRETS_TEXT.empty}</p> : null}
      {view && view.secrets.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {view.secrets.map((s) => (
            <li key={s.name} data-secret={s.name} className="flex items-center gap-2">
              <code className="flex-1">{s.name}</code>
              <span className="opacity-70">{s.lastUsedAt === null ? SECRETS_TEXT.neverUsed : SECRETS_TEXT.lastUsed(s.lastUsedAt)}</span>
              <AllowSecret name={s.name} workspace={workspace} />
              <Button size="sm" variant="secondary" onClick={() => void remove(s.name)}>{SECRETS_TEXT.delete}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {view ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Input aria-label={SECRETS_TEXT.name} placeholder={SECRETS_TEXT.name} value={name} onChange={(e) => setName(e.target.value.toUpperCase())} className="min-w-32 flex-1" />
          <Input aria-label={SECRETS_TEXT.value} placeholder={SECRETS_TEXT.value} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className="min-w-32 flex-1" />
          <Button size="sm" onClick={() => void save()} disabled={!NAME_RE.test(name.trim()) || value.trim() === ''}>{SECRETS_TEXT.save}</Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {view ? (
        <div className="mt-2">
          <h4 className="text-xs font-semibold">{SECRETS_TEXT.usageTitle}</h4>
          {view.usage === null ? <p className="text-xs opacity-70">{SECRETS_TEXT.usageOff}</p> : null}
          {view.usage?.length === 0 ? <p className="text-xs opacity-70">{SECRETS_TEXT.usageEmpty}</p> : null}
          {view.usage && view.usage.length > 0 ? (
            <table className="mt-1 border-collapse text-xs" aria-label={SECRETS_TEXT.usageTitle}>
              <thead>
                <tr className="text-left opacity-70">
                  {[SECRETS_TEXT.colWhen, SECRETS_TEXT.colName, SECRETS_TEXT.colWho, SECRETS_TEXT.colCommand, SECRETS_TEXT.colResult].map((h) => <th key={h} className="pr-4">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.usage.map((u) => (
                  <tr key={u.seq} data-use={u.seq}>
                    <td className="pr-4">{new Date(u.ts).toLocaleString()}</td>
                    <td className="pr-4"><code>{u.name}</code></td>
                    <td className="pr-4">{whoText(u.principal)}</td>
                    {/* The broker logs a hash, never the command line itself. */}
                    <td className="pr-4"><code>{u.commandHash.slice(0, 12)}</code></td>
                    <td>{u.exitCode === null ? SECRETS_TEXT.noResult : u.exitCode === 0 ? SECRETS_TEXT.ok : SECRETS_TEXT.exitFailed(u.exitCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
