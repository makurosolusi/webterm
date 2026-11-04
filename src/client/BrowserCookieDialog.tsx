// Dialog impor cookie: unggah berkas -> preview -> pilih domain -> commit; hapus per domain.
// Hanya NAMA domain + jumlah yang pernah masuk state/DOM; isi berkas dikirim langsung dan dilepas.
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { COOKIE_BODY_MAX_BYTES } from '../shared/browser.contract'
import type { CookieDomainInfo, CookieFormat, CookiePreviewResp } from '../shared/browser.contract'
import { BrowserApiError, clearCookies, commitCookies, listCookieDomains, previewCookies } from './browser.api'
import { writeClipboard } from './clipboard'
import { COOKIE_TEXT as T } from './browser.uxText'

export interface BrowserCookieDialogProps {
  /** Dari `BrowserStatusResp.cookieImportEnabled`; false = tidak dirender sama sekali. */
  cookieImportEnabled: boolean
  workspaceId: string
  open: boolean
  onClose: () => void
}

const FORMATS = Object.keys(T.formats) as CookieFormat[]

function failText(e: unknown): string {
  if (e instanceof BrowserApiError) {
    if (e.code === 'bad_request' || e.code === 'not_found' || e.code === 'disabled' || e.code === 'payload_too_large') return T.errors[e.code]
    if (e.status === 413) return T.errors.payload_too_large
  }
  return T.errors.generic
}

/** Dialog modal untuk impor/hapus cookie workspace; peringatan risiko selalu tampil. */
export default function BrowserCookieDialog({ cookieImportEnabled, workspaceId, open, onClose }: BrowserCookieDialogProps) {
  const [stored, setStored] = useState<CookieDomainInfo[] | null>(null)
  const [format, setFormat] = useState<CookieFormat>('storageState')
  const [preview, setPreview] = useState<CookiePreviewResp | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStored((await listCookieDomains(workspaceId)).domains)
    } catch (e) {
      setStored([])
      setError(failText(e))
    }
  }, [workspaceId])

  useEffect(() => {
    if (open && cookieImportEnabled) { setPreview(null); setPicked(new Set()); setResult(null); setError(null); void refresh() }
  }, [open, cookieImportEnabled, refresh])

  if (!cookieImportEnabled) return null

  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await job() } catch (e) { setError(failText(e)) } finally { setBusy(false) }
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // izinkan memilih berkas yang sama lagi
    if (!file) return
    if (file.size > COOKIE_BODY_MAX_BYTES) { setError(T.tooLarge); return }
    void run(async () => {
      const content = await file.text().catch(() => null)
      if (content === null) { setError(T.readFail); return }
      const p = await previewCookies(workspaceId, { format, content })
      setPreview(p); setPicked(new Set()); setResult(null)
    })
  }

  const toggle = (domain: string, on: boolean) =>
    setPicked((s) => { const n = new Set(s); if (on) n.add(domain); else n.delete(domain); return n })

  const commit = () => preview && void run(async () => {
    const r = await commitCookies(workspaceId, { previewId: preview.previewId, domains: [...picked] })
    setPreview(null); setPicked(new Set())
    setResult(T.imported(r.imported, r.domains.length))
    await refresh()
  })

  const remove = (domain?: string) => void run(async () => { await clearCookies(workspaceId, domain); await refresh() })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.description}</DialogDescription>
        </DialogHeader>
        <p role="note" className="m-0 text-xs text-(--vscode-errorForeground)">{T.warning}</p>

        <details className="text-xs">
          <summary className="cursor-pointer font-semibold">{T.guide.summary}</summary>
          <div className="flex flex-col gap-1 pt-1">
            <p className="m-0">{T.guide.optionA}</p>
            <p className="m-0">{T.guide.optionB}</p>
            <div className="flex items-center gap-2">
              <code aria-label={T.guide.commandLabel} className="flex-1 break-all select-all">{T.guide.command}</code>
              <Button size="xs" variant="outline" onClick={() => void writeClipboard(T.guide.command).then(setCopied)}>{copied ? T.guide.copied : T.guide.copy}</Button>
            </div>
            <p className="m-0">{T.guide.formatHint}</p>
            <p className="m-0 text-(--vscode-errorForeground)">{T.guide.warning}</p>
            <p className="m-0">{T.guide.safest}</p>
          </div>
        </details>

        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2">
            {T.formatLabel}
            <select value={format} disabled={busy} onChange={(e) => setFormat(e.target.value as CookieFormat)}>
              {FORMATS.map((f) => <option key={f} value={f}>{T.formats[f]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            {T.fileLabel}
            <input type="file" disabled={busy} onChange={onFile} />
          </label>
        </div>

        {busy && <p role="status" className="m-0 text-xs">{T.previewing}</p>}
        {error && <p role="alert" className="m-0 text-xs text-(--vscode-errorForeground)">{error}</p>}
        {result && <p role="status" className="m-0 text-xs">{result}</p>}

        {preview && (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0 text-xs">
            <legend className="font-semibold">{T.domainsHeading}</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox" checked={picked.size === preview.domains.length && picked.size > 0}
                onChange={(e) => setPicked(new Set(e.target.checked ? preview.domains.map((d) => d.domain) : []))}
              />
              {T.selectAll}
            </label>
            {preview.domains.map((d) => (
              <label key={d.domain} className="flex items-center gap-2">
                <input
                  type="checkbox" aria-label={T.selectLabel(d.domain)} checked={picked.has(d.domain)}
                  onChange={(e) => toggle(d.domain, e.target.checked)}
                />
                <span>{d.domain}</span>
                <span>{T.cookieCount(d.count)}{d.hasSession ? ` · ${T.sessionTag}` : ''}</span>
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="xs" disabled={busy} onClick={() => { setPreview(null); setPicked(new Set()) }}>{T.cancel}</Button>
              <Button size="xs" disabled={busy || picked.size === 0} onClick={commit}>{busy ? T.importing : T.import}</Button>
            </div>
          </fieldset>
        )}

        <section aria-label={T.storedHeading} className="flex flex-col gap-1 text-xs">
          <h3 className="m-0 text-xs font-semibold">{T.storedHeading}</h3>
          {stored === null && <p className="m-0">{T.loading}</p>}
          {stored?.length === 0 && <p className="m-0">{T.storedEmpty}</p>}
          {stored?.map((d) => (
            <div key={d.domain} className="flex items-center gap-2">
              <span className="flex-1">{d.domain} · {T.cookieCount(d.count)}</span>
              <Button size="xs" variant="outline" disabled={busy} aria-label={T.removeLabel(d.domain)} onClick={() => remove(d.domain)}>×</Button>
            </div>
          ))}
          {!!stored?.length && <Button size="xs" variant="outline" disabled={busy} onClick={() => remove()}>{T.removeAll}</Button>}
        </section>

        <div className="flex justify-end"><Button size="xs" variant="secondary" onClick={onClose}>{T.close}</Button></div>
      </DialogContent>
    </Dialog>
  )
}
