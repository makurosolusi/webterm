// Held Claude Code permission prompts (F3-b) at the top of the Inbox: "<node> wants to run: Bash(npm
// publish)" with Allow once / Deny / Always allow. Claude is waiting on the hook while a row is here,
// so the list polls on its own; a row leaves when decided, expired, or answered in the terminal.
// "Always allow" is UI-only on purpose (K4): it writes a permanent rule, Telegram can only allow once.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { APPROVAL_PATH, inboxErrorMessage, isAbortError } from './inboxApi'
import { request } from './inboxTransport'

export const PERMISSION_PATH = `${APPROVAL_PATH}/permission`
/** Approval ids of permission prompts; the generic inbox sections skip these rows. */
export const isPermissionItemId = (id: string): boolean => id.startsWith('perm_')
const POLL_MS = 2000

export interface PendingPermission {
  id: string
  node: string
  label: string
  pattern: string | null
  expiresAt: number | null
}

type Choice = 'allow' | 'deny' | 'always'

const toRow = (raw: unknown): PendingPermission | null => {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.label !== 'string') return null
  return {
    id: r.id, label: r.label, node: typeof r.node === 'string' ? r.node : 'agent',
    pattern: typeof r.pattern === 'string' ? r.pattern : null,
    expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
  }
}

export function InboxPermissions(props: { pollMs?: number }): React.JSX.Element | null {
  const [rows, setRows] = useState<PendingPermission[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const pollMs = props.pollMs ?? POLL_MS

  useEffect(() => {
    const ctl = new AbortController()
    request<{ items?: unknown[] }>(PERMISSION_PATH, { signal: ctl.signal })
      .then((body) => setRows((body?.items ?? []).map(toRow).filter((r): r is PendingPermission => r !== null)))
      .catch((err: unknown) => { if (!isAbortError(err)) setError(inboxErrorMessage(err)) })
    const t = pollMs > 0 ? setTimeout(() => setTick((n) => n + 1), pollMs) : undefined
    return () => { ctl.abort(); if (t) clearTimeout(t) }
  }, [tick, pollMs])

  const decide = useCallback(async (id: string, choice: Choice) => {
    setBusy(id)
    setError(null)
    try {
      await request(PERMISSION_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, choice }) })
      setRows((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      setError(inboxErrorMessage(err))
      setTick((n) => n + 1) // decided elsewhere or expired: re-read what is still open
    } finally {
      setBusy(null)
    }
  }, [])

  if (rows.length === 0 && !error) return null
  return (
    <section className="inbox-section" aria-label="Agent permission requests">
      {error && <p className="inbox-error" role="alert"><span className="inbox-error__text">{error}</span></p>}
      <ul className="inbox-list">
        {rows.map((r) => {
          const title = `${r.node} wants to run: ${r.label}`
          return (
            <li key={r.id} className="inbox-item" data-permission-id={r.id} title={title}>
              <span className="codicon codicon-shield inbox-state inbox-state--needs_you" role="img" aria-label="Needs you" />
              <span className="inbox-item__title">{title}</span>
              <Button size="sm" disabled={busy === r.id} onClick={() => void decide(r.id, 'allow')}>Allow once</Button>
              <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void decide(r.id, 'deny')}>Deny</Button>
              {r.pattern !== null && (
                <Button size="sm" variant="secondary" disabled={busy === r.id}
                  title={`Saves a permanent rule: ${r.label.split('(')[0]}(${r.pattern})`} onClick={() => void decide(r.id, 'always')}>
                  Always allow this pattern
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
