// Cookies already stored for the target: per-site rows (count, expiry), a remove icon per site, and "Clear all"
// behind a confirmation. Names and counts only; the server never returns a value.
import { useState } from 'react'
import { Cookie, Trash2 } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import type { CookieDomainInfo } from '../../shared/browser.contract'
import { relativeExpiry } from './cookieImport.logic'
import { CI } from './cookieImport.text'

export default function CookieStoredList({ stored, failed, note, disabled, onRemove, now = Date.now() }: {
  stored: CookieDomainInfo[] | null
  failed: boolean
  /** Result of the last removal, announced politely. */
  note: string | null
  disabled: boolean
  onRemove: (domain?: string) => void
  now?: number
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <section aria-labelledby="cookie-stored-h" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="cookie-stored-h" className="m-0 text-[length:var(--bui-font)] font-semibold">{CI.stored.heading}</h3>
        {!!stored?.length && <Button type="button" variant="destructive" size="bui" disabled={disabled} onClick={() => setConfirm(true)}>{CI.stored.clearAll}</Button>}
      </div>
      {stored === null && <p className="m-0 text-[length:var(--bui-font-sm)]">{CI.stored.loading}</p>}
      {failed && <p role="alert" className="m-0 text-[length:var(--bui-font-sm)] text-(--vscode-errorForeground)">{CI.stored.loadFail}</p>}
      {stored?.length === 0 && !failed && (
        <p className="m-0 flex items-center gap-2 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)"><Cookie aria-hidden="true" className="size-4 shrink-0" />{CI.stored.empty}</p>
      )}
      {!!stored?.length && (
        <ul className="m-0 flex max-h-[160px] list-none flex-col overflow-y-auto p-0">
          {stored.map((d) => (
            <li key={d.domain} className="flex min-h-(--bui-hit) items-center gap-2 px-1 text-[length:var(--bui-font)]">
              <span className="min-w-0 flex-1 truncate">{d.domain}</span>
              <span className="text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">
                {CI.stored.count(d.count)}{d.expiresAt ? ` · ${CI.stored.expires(relativeExpiry(d.expiresAt, now))}` : ''}
              </span>
              <IconButton size="icon-bui" label={CI.stored.remove(d.domain)} disabled={disabled} onClick={() => onRemove(d.domain)}><Trash2 aria-hidden="true" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="m-0 min-h-4 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{note}</p>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{CI.stored.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{CI.stored.confirmBody(stored?.length ?? 0)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{CI.stored.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onRemove()}>{CI.stored.confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
