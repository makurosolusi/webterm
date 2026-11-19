// "Import cookies" dialog: pick or drop a file -> detected format -> per-site preview -> import -> summary, with the
// stored cookies below. One component for both targets (workspace browser, profile); see docs/decisions/browser-profiles.md.
import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CookieFormat } from '../../shared/browser.contract'
import CookieDropZone from './CookieDropZone'
import { CookieHelp, CookieSecurityAlert } from './CookieNotes'
import CookiePreviewList, { pickedCookieCount } from './CookiePreviewList'
import { CookieDisabled, CookieError, CookieResultView } from './CookieStatus'
import CookieStoredList from './CookieStoredList'
import type { CookieTarget } from './cookieImport.target'
import { CI, FORMAT_LABELS } from './cookieImport.text'
import { useCookieImport } from './useCookieImport'

const FORMATS = Object.keys(FORMAT_LABELS) as CookieFormat[]

export interface CookieImportDialogProps {
  target: CookieTarget
  onClose: () => void
  /** Called after cookies were imported or removed (the caller refreshes counts). */
  onChanged?: () => void
}

export default function CookieImportDialog({ target, onClose, onChanged }: CookieImportDialogProps): React.JSX.Element {
  const c = useCookieImport(target, onChanged)
  const { s } = c
  const chooseRef = useRef<HTMLButtonElement>(null)
  const [override, setOverride] = useState(false)
  const importing = s.stage === 'importing'
  const disabled = s.error === 'disabled'
  const count = s.preview ? pickedCookieCount(s.preview, s.picked) : 0
  // Closing is refused while a request is in flight: the server would finish without anyone watching.
  const guard = (o: boolean): void => { if (!o && !c.busy) onClose() }
  const showFormat = !!s.file && (s.needFormat || s.error === 'invalid' || s.error === 'empty' || override)
  const reset = (): void => { setOverride(false); c.reset() }

  return (
    <Dialog open onOpenChange={guard}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] gap-3 overflow-y-auto p-4 sm:max-w-[560px]"
        onOpenAutoFocus={(e) => { e.preventDefault(); chooseRef.current?.focus() }}
        onEscapeKeyDown={(e) => { if (c.busy) e.preventDefault() }}
        onInteractOutside={(e) => { if (c.busy) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{CI.title}</DialogTitle>
          <DialogDescription>{CI.description}</DialogDescription>
          <Badge variant="outline" className="w-fit max-w-full truncate">{CI.into(target.name)}</Badge>
        </DialogHeader>

        {disabled ? <CookieDisabled onClose={onClose} /> : (
          <>
            <CookieSecurityAlert />
            {s.stage === 'done' && s.result ? <CookieResultView result={s.result} onDone={onClose} onAnother={reset} /> : (
              <>
                {(s.stage === 'pick' || s.stage === 'reading') && (
                  <CookieDropZone chooseRef={chooseRef} disabled={c.busy} fileName={s.stage === 'reading' ? (s.file?.name ?? '') : null} onFile={(f) => c.load(f)} />
                )}
                {s.error && <CookieError kind={s.error} />}
                {showFormat && (
                  <div className="flex items-center gap-2 text-[length:var(--bui-font-sm)]">
                    <span id="cookie-format-l">{CI.format.label}</span>
                    <Select value={s.format ?? undefined} disabled={c.busy} onValueChange={(f) => { if (s.file) c.load(s.file, f as CookieFormat) }}>
                      <SelectTrigger size="sm" aria-labelledby="cookie-format-l"><SelectValue placeholder={CI.format.unknown} /></SelectTrigger>
                      <SelectContent>{FORMATS.map((f) => <SelectItem key={f} value={f}>{FORMAT_LABELS[f]}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                {(s.stage === 'preview' || importing) && s.preview && (
                  <>
                    {s.format && (
                      <div className="flex items-center gap-2 text-[length:var(--bui-font-sm)]">
                        <Badge variant="secondary">{s.detected ? CI.format.detected(s.format) : FORMAT_LABELS[s.format]}</Badge>
                        {!override && <Button type="button" variant="link" size="bui" disabled={c.busy} onClick={() => setOverride(true)}>{CI.format.override}</Button>}
                      </div>
                    )}
                    <CookiePreviewList preview={s.preview} picked={s.picked} onPicked={c.setPicked} disabled={c.busy} />
                  </>
                )}
                {(s.stage === 'pick' || s.stage === 'reading') && <CookieHelp />}
              </>
            )}
          </>
        )}

        <CookieStoredList stored={c.stored} failed={c.storedFailed} note={c.storedNote} disabled={c.busy} onRemove={c.removeStored} />

        {!disabled && s.stage !== 'done' && (
          <div className="flex items-center justify-end gap-2" data-slot="cookie-footer">
            {s.preview && count === 0 && <span id="cookie-import-why" className="mr-auto text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.action.pickOne}</span>}
            {s.preview ? (
              <>
                <Button type="button" variant="secondary" size="bui" disabled={c.busy} onClick={reset}>{CI.action.cancel}</Button>
                <Button type="button" size="bui" disabled={c.busy || count === 0} aria-describedby={count === 0 ? 'cookie-import-why' : undefined} onClick={c.commit}>
                  {importing && <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{importing ? CI.action.importing : CI.action.import(count)}
                </Button>
              </>
            ) : <Button type="button" variant="secondary" size="bui" disabled={c.busy} onClick={onClose}>{CI.action.close}</Button>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
