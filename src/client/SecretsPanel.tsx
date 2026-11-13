// Secrets part of Settings › Rules & secrets: the secret broker's names, add/replace, delete and usage log
// (`/api/secrets`, UI-only on the server). Values go out once on save and never come back: like a password
// manager or Vercel's environment variables, a saved value is only dots, the value box has Show/Hide while
// you type, Copy copies the name (what a command refers to), and Delete asks first.
import { useCallback, useEffect, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { writeClipboard } from './clipboard'
import { secretRule } from './policyPresets'
import { createRule } from './policyRules.api'
import { CardEmpty, CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { SafeguardNote } from './SettingsFields'
import { SecretsUsage, type SecretUse } from './SecretsUsage'
import { SECRETS_TEXT as T } from './secretsLabels'

export { SECRETS_TEXT } from './secretsLabels'
export type { SecretUse } from './SecretsUsage'
export const SECRETS_PATH = '/api/secrets'

export interface SecretEntry { name: string; lastUsedAt: number | null }
interface SecretsView { secrets: SecretEntry[]; usage: SecretUse[] | null }

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const COPIED_MS = 1500

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
    if (!workspace) throw new Error(T.noWorkspace) // the button is locked then; guards a stale click
    await createRule({ subject: 'node:*', ...secretRule(name), workspaceId: workspace.id, effect: 'allow' })
  }, { label: `${workspace ? T.allow(workspace.name) : T.allowNoWorkspace}: ${name}`, success: () => T.allowed(name, workspace?.name ?? ''), toast: 'always' })
  return (
    <span className="flex flex-col items-end gap-0.5">
      <ActionButton size="sm" variant="outline" action={allow} busyLabel={T.allowing} lock={workspace ? undefined : { reason: T.noWorkspace }}>
        {workspace ? T.allow(workspace.name) : T.allowNoWorkspace}
      </ActionButton>
      <ActionResult action={allow} />
    </span>
  )
}

function SecretRow({ s, workspace, onDelete }: { s: SecretEntry; workspace: SecretsWorkspace | null; onDelete(): void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    writeClipboard(s.name).then((ok) => {
      setCopied(ok)
      if (ok) window.setTimeout(() => setCopied(false), COPIED_MS)
    }, (err: unknown) => console.warn(`secrets: copying the name ${s.name} failed`, err))
  }
  return (
    <li data-secret={s.name} className="st-field">
      <div className="st-field-text">
        <code className="st-row-title">{s.name}</code>
        <p className="st-row-meta">
          <span className="st-mask" aria-hidden="true">{T.mask}</span><span className="sr-only">{T.maskLabel}</span>
          {' · '}{s.lastUsedAt === null ? T.neverUsed : T.lastUsed(s.lastUsedAt)}
        </p>
      </div>
      <div className="st-control">
        <IconButton size="icon-sm" label={copied ? T.copied : T.copyName(s.name)} onClick={copy}>
          <span className={`codicon ${copied ? 'codicon-check' : 'codicon-copy'}`} aria-hidden="true" />
        </IconButton>
        <AllowSecret name={s.name} workspace={workspace} />
        <IconButton size="icon-sm" label={T.deleteName(s.name)} onClick={onDelete}>
          <span className="codicon codicon-trash" aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  )
}

export function SecretsPanel({ workspace = null }: { workspace?: SecretsWorkspace | null }): React.JSX.Element {
  const [view, setView] = useState<SecretsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    secretsRequest('GET')
      .then((v) => { if (isView(v)) setView(v); else setLoadError(T.loadFailed) })
      .catch((e: unknown) => setLoadError(`${T.loadFailed} ${errorCause(e)}`))
  }, [])
  useEffect(load, [load])

  const closeForm = (): void => { setAdding(false); setName(''); setValue(''); setShown(false) }
  const save = useAction(async () => {
    const n = name.trim()
    await secretsRequest('PUT', `${SECRETS_PATH}/${encodeURIComponent(n)}`, { value })
    closeForm()
    load()
    return n
  }, { label: T.save, success: (n) => T.saved(n), failure: (e) => T.failed(T.save, errorCause(e)) })
  const saveLock = !NAME_RE.test(name.trim()) ? T.badName : value.trim() === '' ? T.needValue : undefined

  const del = useAction(async () => {
    const n = deleting ?? ''
    setDeleting(null)
    await secretsRequest('DELETE', `${SECRETS_PATH}/${encodeURIComponent(n)}`)
    load()
    return n
  }, { label: T.delete, success: (n) => T.deleted(n), failure: (e) => T.failed(T.delete, errorCause(e)) })
  const confirmDelete = (): void => { void del.run() }

  const addButton = <Button size="sm" variant="outline" onClick={() => setAdding(true)}>{T.add}</Button>
  return (
    <div data-testid="secrets-panel" className="contents">
      <SettingsGroup title={T.title} description={T.intro}>
        <div className="st-state st-state--empty"><SafeguardNote id="secretAccess" /><p className="st-hint">{T.detail}</p></div>
        {loadError ? <CardError text={loadError} onRetry={load} /> : null}
        {!view && !loadError ? <CardLoading text={T.loading} /> : null}
        {view?.secrets.length === 0 && !adding ? <CardEmpty text={T.empty}>{addButton}</CardEmpty> : null}
        {view && view.secrets.length > 0 ? (
          <ul className="st-list" aria-label={T.title}>
            {view.secrets.map((s) => <SecretRow key={s.name} s={s} workspace={workspace} onDelete={() => setDeleting(s.name)} />)}
          </ul>
        ) : null}
        {view && adding ? (
          <form className="st-form" aria-label={T.addTitle} onSubmit={(e) => { e.preventDefault(); if (!saveLock) void save.run() }}>
            <div className="st-form-row">
              <span className="flex flex-col gap-1">
                <Label htmlFor="secret-name">{T.name}</Label>
                <Input id="secret-name" className="st-mono" placeholder={T.namePlaceholder} autoComplete="off" spellCheck={false} autoFocus
                  value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
              </span>
              <span className="flex flex-col gap-1">
                <Label htmlFor="secret-value">{T.value}</Label>
                <span className="flex items-center gap-1">
                  <Input id="secret-value" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                    value={value} onChange={(e) => setValue(e.target.value)} />
                  <Button type="button" variant="ghost" size="sm" aria-pressed={shown} aria-label={shown ? T.hideValue : T.showValue}
                    onClick={() => setShown((v) => !v)}>{shown ? T.hide : T.show}</Button>
                </span>
              </span>
            </div>
            <p className="st-row-meta">{T.replaceHint}</p>
            <div className="st-form-actions">
              <ActionButton size="sm" type="button" action={save} busyLabel={T.saving} lock={saveLock ? { reason: saveLock } : undefined}>{T.save}</ActionButton>
              <Button size="sm" variant="ghost" type="button" onClick={closeForm}>{T.cancel}</Button>
            </div>
          </form>
        ) : null}
        {view && view.secrets.length > 0 && !adding ? <div className="st-form">{addButton}</div> : null}
        {save.result || del.result ? (
          <div className="st-form"><ActionResult action={save} /><ActionResult action={del} /></div>
        ) : null}
      </SettingsGroup>
      {view ? <SecretsUsage usage={view.usage} /> : null}
      {deleting !== null ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setDeleting(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{T.deleteTitle(deleting)}</AlertDialogTitle>
              <AlertDialogDescription>{T.deleteBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{T.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmDelete}>{T.delete}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}
