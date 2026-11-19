// State machine of the import dialog: pick -> reading -> preview -> importing -> done, plus the stored-cookie list.
// Only the File handle is kept between steps (re-read on a format override); cookie values never enter React state.
import { useCallback, useEffect, useState } from 'react'
import { COOKIE_BODY_MAX_BYTES } from '../../shared/browser.contract'
import type { CookieDomainInfo, CookieFormat, CookiePreviewResp } from '../../shared/browser.contract'
import { classifyCookieError, detectCookieFormat, hasCookieExtension } from './cookieImport.logic'
import type { CookieErrorKind } from './cookieImport.logic'
import type { CookieTarget } from './cookieImport.target'
import { CI } from './cookieImport.text'

export type CookieStage = 'pick' | 'reading' | 'preview' | 'importing' | 'done'
export interface CookieResult { imported: number; sites: number; domains: string[]; skipped: number; reasons: string[] }

export interface CookieImportState {
  stage: CookieStage
  file: File | null
  format: CookieFormat | null
  /** True while the format is only a guess; false after the user picked one. */
  detected: boolean
  /** Detection failed: the Format control is shown and the dialog waits for a choice. */
  needFormat: boolean
  preview: CookiePreviewResp | null
  picked: ReadonlySet<string>
  error: CookieErrorKind | null
  result: CookieResult | null
}

const INITIAL: CookieImportState = { stage: 'pick', file: null, format: null, detected: true, needFormat: false, preview: null, picked: new Set(), error: null, result: null }

export function useCookieImport(target: CookieTarget, onChanged?: () => void) {
  const [s, setS] = useState<CookieImportState>(INITIAL)
  const [stored, setStored] = useState<CookieDomainInfo[] | null>(null)
  const [storedFailed, setStoredFailed] = useState(false)
  const [storedNote, setStoredNote] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const patch = (p: Partial<CookieImportState>): void => setS((c) => ({ ...c, ...p }))

  const refresh = useCallback((): void => {
    target.list().then((d) => { setStored(d); setStoredFailed(false) }, () => { setStored([]); setStoredFailed(true) })
  }, [target])
  useEffect(refresh, [refresh])

  const fail = (kind: CookieErrorKind, extra: Partial<CookieImportState> = {}): void => patch({ stage: 'pick', error: kind, ...extra })

  /** Read `file`, sniff the format (or use the user's `forced` one) and ask the server for the per-site preview. */
  const load = (file: File, forced?: CookieFormat): void => {
    if (!hasCookieExtension(file.name)) return fail('wrong_type', { file: null, preview: null })
    if (file.size > COOKIE_BODY_MAX_BYTES) return fail('too_large', { file: null, preview: null })
    patch({ stage: 'reading', file, error: null, preview: null, picked: new Set(), needFormat: false })
    file.text().then(
      (content) => {
        const format = forced ?? detectCookieFormat(content)
        if (!format) return fail('invalid', { file, format: null, needFormat: true })
        patch({ format, detected: forced === undefined })
        return target.preview({ format, content }).then((p) => {
          const picked = new Set(p.domains.map((d) => d.domain)) // default: every importable site
          patch({ stage: 'preview', preview: p, picked, error: null })
        })
      },
      () => fail('unreadable', { file: null }),
    ).catch((e: unknown) => fail(classifyCookieError(e), { file }))
  }

  const commit = (): void => {
    if (!s.preview) return
    const { preview, picked } = s
    patch({ stage: 'importing', error: null })
    target.commit({ previewId: preview.previewId, domains: [...picked] }).then((r) => {
      const reasons = [...new Set((preview.blocked ?? []).map((b) => b.reason))]
      patch({ stage: 'done', preview: null, file: null, result: { imported: r.imported, sites: r.domains.length, domains: r.domains, skipped: preview.googleSkipped ?? 0, reasons } })
      refresh(); onChanged?.()
    }).catch((e: unknown) => patch({ stage: 'preview', error: classifyCookieError(e) }))
  }

  const removeStored = (domain?: string): void => {
    setClearing(true); setStoredNote(null)
    target.clear(domain).then(() => { refresh(); onChanged?.(); setStoredNote(domain === undefined ? CI.stored.cleared : CI.stored.removed(domain)) }, (e: unknown) => patch({ error: classifyCookieError(e) })).finally(() => setClearing(false))
  }

  return {
    s, stored, storedFailed, storedNote, clearing,
    busy: s.stage === 'reading' || s.stage === 'importing' || clearing,
    load, commit, removeStored,
    setPicked: (picked: ReadonlySet<string>): void => patch({ picked }),
    reset: (): void => setS(INITIAL),
    dismissError: (): void => patch({ error: null }),
  }
}
