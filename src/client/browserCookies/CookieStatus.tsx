// Outcome views of the import dialog: a specific error (what happened + what to do), the import summary,
// and the "import is turned off" panel. Red is reserved for real errors; the summary is neutral.
import { CircleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { openSettingsSection } from '../settings.link'
import type { CookieErrorKind } from './cookieImport.logic'
import { CI } from './cookieImport.text'
import type { CookieResult } from './useCookieImport'

/** Settings section that holds the cookie import switch (Browser). */
const BROWSER_SETTINGS_SECTION = 'browser'

export function CookieError({ kind }: { kind: CookieErrorKind }): React.JSX.Element {
  const t = CI.errors[kind]
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t.title}</AlertTitle>
      <AlertDescription>{t.body}</AlertDescription>
    </Alert>
  )
}

export function CookieDisabled({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-slot="cookie-disabled">
      <Alert variant="default" role="status">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{CI.errors.disabled.title}</AlertTitle>
        <AlertDescription>{CI.errors.disabled.body}</AlertDescription>
      </Alert>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="bui" onClick={onClose}>{CI.action.close}</Button>
        <Button type="button" size="bui" onClick={() => { onClose(); openSettingsSection(BROWSER_SETTINGS_SECTION) }}>{CI.settings}</Button>
      </div>
    </div>
  )
}

export function CookieResultView({ result, onDone, onAnother }: { result: CookieResult; onDone: () => void; onAnother: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-slot="cookie-result">
      <div role="status" className="flex flex-col gap-1">
        <h3 className="m-0 text-[length:var(--bui-font)] font-semibold">{CI.result.title}</h3>
        <p className="m-0 text-[length:var(--bui-font)]">{result.imported > 0 ? CI.result.imported(result.imported, result.sites) : CI.result.nothing}</p>
        {result.domains.length > 0 && <p className="m-0 break-words text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{result.domains.join(', ')}</p>}
        {result.skipped > 0 && <p className="m-0 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.result.skipped(result.skipped)}</p>}
        {result.reasons.map((r) => <p key={r} className="m-0 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.result.reasons[r] ?? r}</p>)}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="bui" onClick={onAnother}>{CI.result.another}</Button>
        <Button type="button" size="bui" onClick={onDone}>{CI.result.done}</Button>
      </div>
    </div>
  )
}
