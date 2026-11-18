// Permukaan interaktif node browser: <canvas> berisi frame + textarea tersembunyi (IME/paste) +
// overlay status/dialog. Overlay dirender SEBAGAI SAUDARA permukaan (bukan anak): kalau tidak,
// ketikan di input dialog ikut diteruskan ke halaman. Kelas `nodrag nowheel nopan nokey` membuat React Flow tidak mencuri
// drag/wheel/keyboard. Seluruh isi halaman asing hanya hadir sebagai piksel di canvas.
import { useEffect, useMemo, useRef } from 'react'
import type { ClipboardEvent, CompositionEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { TouchPoint } from '../shared/browser.contract'
import { Textarea } from '@/components/ui/textarea'
import BrowserDialogView from './browser.dialog'
import { chunkText, classifyKey, keyMsg, makeClickCounter, makeMoveCoalescer, mouseMsg, touchMsg, wheelMsg } from './browser.input'
import { pastedText } from './browser.clipboard'
import { browserNotice } from './browser.status'
import type { BrowserSession } from './browser.useSession'
import InputLatencyChip from './browser/latency/InputLatencyChip'

const TOUCH_KIND = { down: 'start', move: 'move', up: 'end', cancel: 'cancel' } as const

/** The interactive canvas of one page (the node's, or one split pane's): pointer, wheel, keys, IME and paste become messages. */
export function BrowserInput({ session }: { session: BrowserSession }) {
  const { canvasRef, viewport } = session
  const rawSend = session.send
  const sendRef = useRef(rawSend)
  sendRef.current = rawSend
  const moves = useMemo(() => makeMoveCoalescer((m) => sendRef.current(m)), [])
  useEffect(() => () => moves.dispose(), [moves])
  // Semua pesan selain mousemove mengirim move tertunda dulu: move terakhir sebelum up tak hilang/terbalik urutan.
  const send = useMemo(() => ((msg: Parameters<typeof rawSend>[0]) => { moves.flush(); rawSend(msg) }) as typeof rawSend, [moves, rawSend])
  const imeRef = useRef<HTMLTextAreaElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const clicks = useRef(makeClickCounter())
  const lastClicks = useRef(0)
  const touches = useRef(new Map<number, TouchPoint>())

  // Wheel WAJIB listener non-passive (React mendaftarkan passive) supaya preventDefault menahan scroll canvas.
  useEffect(() => {
    const host = surfaceRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = canvasRef.current, vp = viewport.current
      const m = c && vp ? wheelMsg(e, c.getBoundingClientRect(), vp) : null
      if (m) send(m)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [canvasRef, viewport, send])

  const pointer = (kind: keyof typeof TOUCH_KIND, e: PointerEvent) => {
    const c = canvasRef.current, vp = viewport.current
    if (!c || !vp) return
    const rect = c.getBoundingClientRect()
    if (e.pointerType === 'touch') {
      const m = touchMsg(TOUCH_KIND[kind], e, touches.current, rect, vp)
      if (m) send(m)
      return
    }
    if (kind === 'cancel') return
    if (kind === 'down') lastClicks.current = clicks.current(e.clientX, e.clientY)
    const m = mouseMsg(kind, e, rect, vp, lastClicks.current)
    if (!m) return
    if (kind === 'move') moves.move(m)
    else send(m)
  }

  const onKey = (type: 'down' | 'up') => (e: KeyboardEvent) => {
    const kind = classifyKey(e.nativeEvent)
    if (kind === 'ignore' || kind === 'paste') return // paste: biarkan event `paste` yang bekerja
    e.preventDefault()
    e.stopPropagation()
    if (kind === 'copy') { if (type === 'down') send({ t: 'copy' }); return }
    send(keyMsg(type, e.nativeEvent))
  }

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    for (const text of chunkText(pastedText(e))) send({ t: 'text', text })
  }
  const onCompositionUpdate = (e: CompositionEvent) =>
    send({ t: 'ime', text: e.data, start: e.data.length, end: e.data.length })
  const onCompositionEnd = (e: CompositionEvent) => {
    send({ t: 'ime', text: '', start: 0, end: 0 }) // bersihkan komposisi sebelum teks final
    if (e.data) send({ t: 'text', text: e.data })
    if (imeRef.current) imeRef.current.value = ''
  }

  return (
    <div
      ref={surfaceRef}
      className="browser-surface nodrag nowheel nopan nokey"
      tabIndex={0}
      style={{ touchAction: 'none' }}
      onFocus={(e) => { if (e.target === e.currentTarget) imeRef.current?.focus({ preventScroll: true }) }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); pointer('down', e) }}
      onPointerMove={(e) => pointer('move', e)}
      onPointerUp={(e) => pointer('up', e)}
      onPointerCancel={(e) => pointer('cancel', e)}
      onKeyDown={onKey('down')}
      onKeyUp={onKey('up')}
      onPaste={onPaste}
      onCompositionUpdate={onCompositionUpdate}
      onCompositionEnd={onCompositionEnd}
    >
      <canvas ref={canvasRef} className="browser-canvas" style={{ cursor: session.cursor }} aria-label="Browser view" />
      <Textarea
        ref={imeRef}
        aria-label="Browser keyboard input"
        className="absolute top-0 left-0 size-px min-h-0 resize-none border-0 p-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        data-tab-shortcuts // the page's own keyboard sink, not a text field: tab shortcuts (Ctrl/Cmd+T, W, ...) must reach the node
      />
    </div>
  )
}

/** The node's stage: the interactive page (or, in a split, the pane tree given as `panes`) plus the status, notice and dialog layers. */
export default function BrowserSurface({ session, panes }: { session: BrowserSession; panes?: ReactNode }) {
  const notice = browserNotice({ state: session.state, error: session.error, connected: session.connected })
  const note = session.localNotice || notice?.text
  return (
    <div ref={session.hostRef} className="browser-stage">
      {panes ?? <BrowserInput session={session} />}
      {!panes && session.state?.loading && <div className="browser-loading" role="progressbar" aria-label="Loading" />}
      <InputLatencyChip window={session.latency} />
      {note && <div className={`browser-notice browser-notice--${session.localNotice ? 'error' : notice?.tone}`} role="status">{note}</div>}
      {session.dialog && (
        <div className="browser-dialog-layer nodrag nowheel nopan nokey">
          <BrowserDialogView
            key={session.dialog.id + session.dialog.message}
            dialog={session.dialog}
            onAnswer={(accept, text) => { session.send({ t: 'dialog', accept, ...(text === undefined ? {} : { text }) }); session.closeDialog() }}
          />
        </div>
      )}
    </div>
  )
}
