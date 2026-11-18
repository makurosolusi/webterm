// Tawaran inline "Izinkan agent mengendalikan browser ini" saat user mematikan sub-opsi `browserAgent` (default on). Meniru Orca
// BrowserUsePane ("Agent Browser Use — Let coding agents drive this browser with your logins"): satu tombol,
// lalu konfirmasi yang menjelaskan risikonya, baru sub-opsi dinyalakan lewat API kemampuan.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { AGENT_OFFER_TEXT as T } from './browser.uxText'

/** `enable` menyalakan sub-opsi di server; gagal = pesan tetap di tempat, tawaran bisa dicoba lagi. */
export default function BrowserAgentOffer({ enable }: { enable: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!asking) {
    return <Button size="bui" variant="ghost" className="whitespace-nowrap" onClick={() => { setAsking(true); setFailed(false) }}>{T.offer}</Button>
  }
  const confirm = (): void => {
    setBusy(true)
    enable().then(() => setAsking(false), () => setFailed(true)).finally(() => setBusy(false))
  }
  return (
    <div role="alertdialog" aria-label={T.offer} className="flex basis-full flex-col gap-1 text-xs">
      <p className="m-0">{T.warning}</p>
      <div className="flex gap-1">
        <Button size="bui" variant="destructive" disabled={busy} onClick={confirm}>{busy ? T.busy : T.confirm}</Button>
        <Button size="bui" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>{T.cancel}</Button>
      </div>
      {failed && <p role="alert" className="m-0 text-(--vscode-errorForeground)">{T.failed}</p>}
    </div>
  )
}
