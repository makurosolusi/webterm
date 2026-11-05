// Design Mode bar of a browser node (G11): toggle, then hover/click elements in the page (the overlay
// draws the highlight and keeps the picks), type a comment, "Send to agent". Imitates Cursor's
// browser "select element" and v0/Lovable visual edit; the server half is src/server/browser/design.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Textarea } from '@/components/ui/textarea'
import { TOKEN_HEADER } from '../../api'
import { BROWSER_REST_PREFIX } from '../../../shared/browser.contract'
import { peekToken } from '../../transportToken'

export const DESIGN_TEXT = {
  toggleOn: 'Design Mode',
  toggleHintOff: 'Design Mode is off: click to pick elements on the page and send them to the wired agent',
  toggleHintOn: 'Design Mode is on: click to turn it off',
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
  const token = peekToken()
  if (token !== '') headers[TOKEN_HEADER] = token
  const res = await fetch(`${BROWSER_REST_PREFIX}/${encodeURIComponent(nodeId)}/design${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { message?: unknown }
  if (!res.ok) throw new Error(typeof data.message === 'string' ? data.message : `${DESIGN_TEXT.failed} (${res.status})`)
  return data as T
}

/** Same cap as the server's `DESIGN_COMMENT_MAX` (design.note.ts). */
const COMMENT_MAX = 2000

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

export default function DesignModeBar({ nodeId }: { nodeId: string }) {
  const [on, setOn] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const onRef = useRef(false)
  onRef.current = on

  // Leaving the board (node removed / unmounted) must not leave the overlay in the page.
  useEffect(() => () => {
    if (onRef.current) designCall(nodeId, '', { on: false }).catch((e: unknown) => console.warn('design.off on unmount failed', e instanceof Error ? e.message : 'unknown'))
  }, [nodeId])

  const fail = (e: unknown) => setMsg({ text: e instanceof Error ? e.message : DESIGN_TEXT.failed, error: true })

  const toggle = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await designCall<{ on: boolean }>(nodeId, '', { on: !on })
      setOn(r.on)
      if (!r.on) setComment('')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const send = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await designCall<{ sentTo: string[] }>(nodeId, '/send', { comment })
      setMsg({ text: DESIGN_TEXT.sent(r.sentTo.length), error: false })
      setComment('')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  return (
    <div className="nodrag flex flex-col gap-1 px-1 pb-1">
      <div className="flex items-center gap-1">
        <IconTooltip label={on ? DESIGN_TEXT.toggleHintOn : DESIGN_TEXT.toggleHintOff} disabled={busy} disabledReason={DESIGN_TEXT.busyReason}>
          <Button size="xs" variant={on ? 'default' : 'ghost'} aria-pressed={on} disabled={busy} onClick={() => void toggle()}>
            {icon('inspect')}{DESIGN_TEXT.toggleOn}
          </Button>
        </IconTooltip>
        {on && <span className="text-xs opacity-70">{DESIGN_TEXT.hint}</span>}
      </div>
      {on && (
        <div className="flex items-start gap-1">
          <Textarea aria-label={DESIGN_TEXT.comment} placeholder={DESIGN_TEXT.placeholder} value={comment} maxLength={COMMENT_MAX} rows={1} onChange={(e) => setComment(e.target.value)} />
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void send()}>{busy ? DESIGN_TEXT.sending : DESIGN_TEXT.send}</Button>
        </div>
      )}
      {msg && <p role={msg.error ? 'alert' : 'status'} className={`m-0 text-xs ${msg.error ? 'text-(--vscode-errorForeground)' : ''}`}>{msg.text}</p>}
    </div>
  )
}
