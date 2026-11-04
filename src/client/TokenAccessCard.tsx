// Kartu "Token akses" (Settings > Kemampuan): status dengan kata biasa, aktifkan/rotasi lewat UI (rute POST
// hanya menerima halaman webterm, approvalAuth.ts). Pola tiru Orca RuntimePairingUrlGenerator.tsx:168-176 (clearGeneratedUrls),
// :178-249 (generate, rotate: true), :301-325 (copyGeneratedUrl)
// (bangkitkan -> tampilkan URL + Salin, bersihkan saat dilepas) dan login App.hooks.ts:48 (storeToken lalu
// reload, karena api.ts menangkap token saat import). Nilai token hanya di state komponen: tidak di log,
// tidak di storage selain sessionStorage transport, hilang saat kartu ditutup.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { storeToken } from './api'
import type { TokenStatus } from './tokenAccess.api.client'
import { enableToken, fetchTokenStatus, rotateToken, tokenErrorText, tokenLink } from './tokenAccess.api.client'
import { TOKEN_TEXT } from './tokenAccessLabels'

export interface TokenAccessCardProps {
  /** Dipanggil setelah token baru terpasang dan kartu ditutup; tes menggantinya. */
  reload?(): void
}

function statusText(s: TokenStatus): string {
  if (!s.enforced) return TOKEN_TEXT.off
  return s.source === 'env' ? TOKEN_TEXT.onEnv : TOKEN_TEXT.onFile
}

/** Kartu token akses; memuat status dari server dan menampilkan tautan token sekali setelah aktifkan/rotasi. */
export function TokenAccessCard({ reload = () => location.reload() }: TokenAccessCardProps): React.JSX.Element {
  const [status, setStatus] = useState<TokenStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean | null>(null)
  // Token baru sudah dipasang di tab ini -> api.ts perlu muat ulang; dijalankan saat Selesai/kartu ditutup.
  const pendingReload = useRef(false)
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  const load = (): void => {
    fetchTokenStatus().then((s) => setStatus(s), () => setError(TOKEN_TEXT.loadFailed))
  }
  useEffect(() => {
    load()
    return () => { if (pendingReload.current) reloadRef.current() }
  }, [])

  const run = async (mint: () => Promise<string>, question: string): Promise<void> => {
    if (!window.confirm(question)) return
    setBusy(true)
    setError(null)
    try {
      const token = await mint()
      storeToken(token) // tab ini tetap jalan: transport membaca sessionStorage (transportToken.ts)
      pendingReload.current = true
      setLink(tokenLink(location.origin, token))
      setCopied(null)
    } catch (e) {
      setError(tokenErrorText(e))
    } finally {
      setBusy(false)
      load()
    }
  }

  const copy = (): void => {
    // Clipboard API tak ada di konteks tidak aman (http lewat alamat lain): tampilkan petunjuk salin manual.
    if (link === null) return
    if (!navigator.clipboard) return setCopied(false)
    navigator.clipboard.writeText(link).then(() => setCopied(true), () => setCopied(false))
  }

  const done = (): void => {
    setLink(null)
    pendingReload.current = false
    reloadRef.current()
  }

  return (
    <section aria-label={TOKEN_TEXT.title} className="flex flex-col gap-2">
      <h3>{TOKEN_TEXT.title}</h3>
      {status === null && error === null ? <p role="status" className="text-xs opacity-70">{TOKEN_TEXT.loading}</p> : null}
      {status ? <p role="status">{statusText(status)}</p> : null}
      {status && !status.enforced ? <p className="text-xs opacity-70">{TOKEN_TEXT.why}</p> : null}
      {status && !status.enforced && !status.canEnable ? <p className="text-xs opacity-70">{TOKEN_TEXT.offRemote}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {link === null && status?.canEnable ? (
        <Button size="sm" disabled={busy} onClick={() => void run(enableToken, TOKEN_TEXT.confirmEnable)}>{TOKEN_TEXT.enable}</Button>
      ) : null}
      {link === null && status?.enforced && status.source === 'file' ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(rotateToken, TOKEN_TEXT.confirmRotate)}>{TOKEN_TEXT.rotate}</Button>
      ) : null}
      {link !== null ? (
        <div className="flex flex-col gap-2">
          <p>{TOKEN_TEXT.linkIntro}</p>
          <div className="flex items-center gap-2">
            <Input aria-label={TOKEN_TEXT.linkLabel} readOnly value={link} onFocus={(e) => e.target.select()} />
            <Button variant="outline" size="sm" onClick={copy}>{copied ? TOKEN_TEXT.copied : TOKEN_TEXT.copy}</Button>
          </div>
          {copied === false ? <p role="alert" className="text-xs text-destructive">{TOKEN_TEXT.copyFailed}</p> : null}
          <p className="text-xs opacity-70">{TOKEN_TEXT.reloadHint}</p>
          <Button size="sm" onClick={done}>{TOKEN_TEXT.done}</Button>
        </div>
      ) : null}
    </section>
  )
}
