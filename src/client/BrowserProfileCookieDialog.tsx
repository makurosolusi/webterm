// Cookies of ONE browser profile: choose a file, preview what it holds (sites, counts, what is skipped and why), tick
// the sites, import, and see the result; below, the sites already stored with a remove button each. Values never
// reach the UI (names of sites and counts only). Google sign-in cookies are skipped by the server; the dialog says so.
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { COOKIE_BODY_MAX_BYTES } from '../shared/browser.contract'
import type { CookieDomainInfo, CookieFormat, CookiePreviewResp } from '../shared/browser.contract'
import type { BrowserProfile } from '../shared/browser.profile'
import { clearProfileCookies, importProfileCookies, listProfileCookies, previewProfileCookies } from './browserProfileApi'
import { PROFILE_TEXT as T, profileErrorText } from './browserProfile.text'
import { COOKIE_TEXT as C } from './browser.uxText'

const FORMATS = Object.keys(C.formats) as CookieFormat[]

export default function BrowserProfileCookieDialog({ profile, onClose, onChanged }: { profile: BrowserProfile; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const [stored, setStored] = useState<CookieDomainInfo[] | null>(null)
  const [format, setFormat] = useState<CookieFormat>('storageState')
  const [preview, setPreview] = useState<CookiePreviewResp | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    listProfileCookies(profile.id).then((r) => setStored(r.domains), (e: unknown) => { setStored([]); setError(profileErrorText(e)) })
  }, [profile.id])
  useEffect(refresh, [refresh])

  const run = (job: Promise<void>): void => {
    setBusy(true); setError(null)
    job.catch((e: unknown) => setError(profileErrorText(e))).finally(() => setBusy(false))
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again
    if (!file) return
    if (file.size > COOKIE_BODY_MAX_BYTES) { setError(C.tooLarge); return }
    run(file.text().then((content) => previewProfileCookies(profile.id, { format, content })).then((p) => { setPreview(p); setPicked(new Set()); setResult(null) }))
  }

  const commit = (): void => {
    if (!preview) return
    run(importProfileCookies(profile.id, { previewId: preview.previewId, domains: [...picked] }).then((r) => {
      setPreview(null); setPicked(new Set())
      setResult(T.importSummary(r.imported, r.domains.length, r.skipped))
      refresh(); onChanged()
    }))
  }

  const remove = (domain?: string): void => run(clearProfileCookies(profile.id, domain).then(() => { refresh(); onChanged() }))
  const all = preview !== null && preview.domains.length > 0 && picked.size === preview.domains.length

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{T.cookiesTitle(profile.name)}</DialogTitle>
          <DialogDescription>{T.cookiesDescription(profile.name)}</DialogDescription>
        </DialogHeader>
        <p role="note" className="m-0 text-xs text-(--vscode-errorForeground)">{C.warning}</p>
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span id="bp-cookie-format">{C.formatLabel}</span>
            <Select value={format} disabled={busy} onValueChange={(v) => setFormat(v as CookieFormat)}>
              <SelectTrigger size="sm" aria-labelledby="bp-cookie-format"><SelectValue /></SelectTrigger>
              <SelectContent>{FORMATS.map((f) => <SelectItem key={f} value={f}>{C.formats[f]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2">{C.fileLabel}<Input type="file" disabled={busy} onChange={onFile} /></label>
        </div>
        {busy && <p role="status" className="m-0 text-xs">{T.working}</p>}
        {error && <p role="alert" className="m-0 text-xs text-(--vscode-errorForeground)">{error}</p>}
        {result && <p role="status" className="m-0 text-xs">{result}</p>}
        {preview && (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0 text-xs">
            <legend className="font-semibold">{C.domainsHeading}</legend>
            {!!preview.googleSkipped && <p role="note" className="m-0">{T.googleSkipped(preview.googleSkipped)}</p>}
            {preview.domains.length === 0 && <p className="m-0">{T.errors.cookie_import_empty}</p>}
            {preview.domains.length > 0 && (
              <label className="flex items-center gap-2">
                <Checkbox checked={all} onCheckedChange={(v) => setPicked(new Set(v === true ? preview.domains.map((d) => d.domain) : []))} />{C.selectAll}
              </label>
            )}
            {preview.domains.map((d) => (
              <label key={d.domain} className="flex items-center gap-2">
                <Checkbox aria-label={C.selectLabel(d.domain)} checked={picked.has(d.domain)}
                  onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v === true) n.add(d.domain); else n.delete(d.domain); return n })} />
                <span>{d.domain}</span><span>{C.cookieCount(d.count)}{d.hasSession ? ` · ${C.sessionTag}` : ''}</span>
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="bui" disabled={busy} onClick={() => { setPreview(null); setPicked(new Set()) }}>{C.cancel}</Button>
              <Button size="bui" disabled={busy || picked.size === 0} onClick={commit}>{busy ? C.importing : C.import}</Button>
            </div>
          </fieldset>
        )}
        <section aria-label={C.storedHeading} className="flex flex-col gap-1 text-xs">
          <h3 className="m-0 text-xs font-semibold">{C.storedHeading}</h3>
          {stored === null && <p className="m-0">{C.loading}</p>}
          {stored?.length === 0 && <p className="m-0">{C.storedEmpty}</p>}
          {stored?.map((d) => (
            <div key={d.domain} className="flex items-center gap-2">
              <span className="flex-1">{d.domain} · {C.cookieCount(d.count)}</span>
              <Button size="bui" variant="outline" disabled={busy} aria-label={C.removeLabel(d.domain)} onClick={() => remove(d.domain)}>×</Button>
            </div>
          ))}
          {!!stored?.length && <Button size="bui" variant="outline" disabled={busy} onClick={() => remove()}>{C.removeAll}</Button>}
        </section>
        <div className="flex justify-end"><Button size="bui" variant="secondary" onClick={onClose}>{C.close}</Button></div>
      </DialogContent>
    </Dialog>
  )
}
