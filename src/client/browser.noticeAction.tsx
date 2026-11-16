// Tombol pemulihan di atas pesan overlay node browser (aksi dari `noticeAction`, browser.status.ts):
// - `offer`: Chromium hilang / browser mati -> tawaran kemampuan Browser yang sama dengan Dock (import saja),
//   jadi kolom lokasi Chromium muncul di tempat, bukan teks "atur lewat Pengaturan".
// - `allowHost`: alamat privat diblokir -> "Izinkan host:port" menulis allowlist Pengaturan lalu membuka ulang.
// - `netError`: navigasi gagal -> plate menutupi halaman galat mentah Chromium (judul, host, petunjuk, Try again = reload).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { BrowserState, NAV_ACTIONS } from '../shared/browser.contract'
import { allowBrowserHosts } from './browser.api'
import { resetBrowserStatusCache } from './browser.feature'
import { noticeAction, type BrowserErr } from './browser.status'
import { NOTICE_ACTION_TEXT as T } from './browser.uxText'
import { CapabilityOffer } from './CapabilityOffer'

export interface NoticeActionProps {
  state?: BrowserState
  error?: BrowserErr
  target?: string
  nav: (action: (typeof NAV_ACTIONS)[number], url?: string) => void
}

const BOX = 'nodrag nowheel absolute bottom-12 left-2 z-10 flex max-w-80 flex-col gap-1 rounded p-2 text-xs ' +
  'bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)'

// Plate over the stream: Chromium's own error page is another product's chrome with no way back.
const PLATE = 'nodrag nowheel absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs ' +
  'bg-(--vscode-editor-background) text-(--vscode-foreground)'
const TRY_AGAIN = 'Try again'
const RETRYING = 'Trying again…'

export default function BrowserNoticeAction({ state, error, target, nav }: NoticeActionProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // A retry ends when the server answers with a new state or error (busy only for the plate's Try again here).
  useEffect(() => { setBusy(false) }, [state, error])
  const action = noticeAction({ state, error, target })
  if (!action) return null
  if (action.kind === 'netError') {
    return (
      <div className={PLATE} role="alert">
        <p className="m-0 text-sm font-semibold">{action.title}</p>
        {action.host && <p className="m-0 opacity-80">{action.host}</p>}
        {action.hint && <p className="m-0 opacity-80">{action.hint}</p>}
        <p className="m-0 font-mono opacity-60">{action.code}</p>
        {action.retryable && (
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => { setBusy(true); nav('reload') }}>{busy ? RETRYING : TRY_AGAIN}</Button>
        )}
      </div>
    )
  }
  if (action.kind === 'offer') {
    return (
      <div className={BOX}>
        {open
          ? <CapabilityOffer id="browser" onDone={() => { setOpen(false); resetBrowserStatusCache() }} />
          : <Button size="xs" variant="secondary" className="self-start" onClick={() => setOpen(true)}>{T.offer}</Button>}
      </div>
    )
  }
  const allow = (): void => {
    setBusy(true)
    setFailed(false)
    allowBrowserHosts(action.entries)
      .then(() => { if (target) nav('go', target) }, () => setFailed(true))
      .finally(() => setBusy(false))
  }
  return (
    <div className={BOX}>
      <p className="m-0 opacity-80">{T.allowHint}</p>
      <Button size="xs" variant="secondary" className="self-start" disabled={busy} onClick={allow}>{T.allow(action.hostPort)}</Button>
      {failed && <p role="alert" className="m-0 text-(--vscode-errorForeground)">{T.allowFailed}</p>}
    </div>
  )
}
