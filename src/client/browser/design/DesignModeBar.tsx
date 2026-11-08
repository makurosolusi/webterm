// Design Mode bar of a browser node (G11), shown while Design Mode is on (toggled from the toolbar ⋯ menu): hover/click elements in the page (the overlay
// draws the highlight and keeps the picks), type a comment, "Send to agent". Imitates Cursor's
// browser "select element" and v0/Lovable visual edit; the server half is src/server/browser/design.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Textarea } from '@/components/ui/textarea'
import { BROWSER_REST_PREFIX } from '../../../shared/browser.contract'
import type { DesignMode } from './useDesignMode'

export const DESIGN_TEXT = {
  toggleOn: 'Design Mode',
  toggleHintOff: 'Design Mode is off: click to pick elements on the page and send them to the wired agent',
  toggleHintOn: 'Design Mode is on: click to turn it off',
  exit: 'Exit Design Mode',
  busyReason: 'request in progress',
  comment: 'Comment for the agent',
  placeholder: 'e.g. make this button bigger',
  send: 'Send to agent',
  sending: 'Sending…',
  hint: 'Hover to highlight, click to pick (click again to unpick, Esc clears).',
  sent: (n: number) => `Sent to ${n} agent${n === 1 ? '' : 's'}.`,
  failed: 'Design Mode request failed.',
} as const

/** POST to `/api/browser/<id>/design[/send]`; rejects with the server's message when there is one. */
export async function designCall<T>(nodeId: string, path: '' | '/send', body: object): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const res = await fetch(`${BROWSER_REST_PREFIX}/${encodeURIComponent(nodeId)}/design${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { message?: unknown }
  if (!res.ok) throw new Error(typeof data.message === 'string' ? data.message : `${DESIGN_TEXT.failed} (${res.status})`)
  return data as T
}

/** Same cap as the server's `DESIGN_COMMENT_MAX` (design.note.ts). */
const COMMENT_MAX = 2000

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

/** Shown only while Design Mode is on (`useDesignMode`): hint, Exit, comment box and "Send to agent". */
export default function DesignModeBar({ nodeId, design }: { nodeId: string; design: DesignMode }) {
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const busy = sending || design.busy

  const send = async () => {
    setSending(true); setMsg(null)
    try {
      const r = await designCall<{ sentTo: string[] }>(nodeId, '/send', { comment })
      setMsg({ text: DESIGN_TEXT.sent(r.sentTo.length), error: false })
      setComment('')
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : DESIGN_TEXT.failed, error: true })
    } finally { setSending(false) }
  }

  return (
    <div className="nodrag flex flex-col gap-1 px-1 pb-1">
      <div className="flex items-center gap-1">
        <span className="codicon codicon-inspect" aria-hidden="true" />
        <span className="text-xs font-semibold">{DESIGN_TEXT.toggleOn}</span>
        <span className="min-w-0 flex-1 truncate text-xs opacity-70">{DESIGN_TEXT.hint}</span>
        <IconButton size="icon-xs" label={DESIGN_TEXT.exit} tooltip={DESIGN_TEXT.toggleHintOn} disabled={busy} disabledReason={DESIGN_TEXT.busyReason} onClick={() => void design.toggle()}>{icon('close')}</IconButton>
      </div>
      <div className="flex items-start gap-1">
        <Textarea aria-label={DESIGN_TEXT.comment} placeholder={DESIGN_TEXT.placeholder} value={comment} maxLength={COMMENT_MAX} rows={1} onChange={(e) => setComment(e.target.value)} />
        <Button size="xs" variant="secondary" disabled={busy} onClick={() => void send()}>{sending ? DESIGN_TEXT.sending : DESIGN_TEXT.send}</Button>
      </div>
      {msg && <p role={msg.error ? 'alert' : 'status'} className={`m-0 text-xs ${msg.error ? 'text-(--vscode-errorForeground)' : ''}`}>{msg.text}</p>}
    </div>
  )
}
