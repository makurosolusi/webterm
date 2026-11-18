// One profile in Settings › Browser: color dot, name (rename in place), badges, counts, and a "⋮" menu with
// Rename, Color, Import cookies, Duplicate, Export and Delete. A refused action says why on the row, inline;
// an action that cannot work right now stays listed, disabled, with its reason as the row's tooltip.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BROWSER_PROFILE_NAME_MAX, validateProfileName } from '../shared/browser.profile'
import type { BrowserProfile } from '../shared/browser.profile'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import ProfileColorPicker from './BrowserProfileColor'
import BrowserProfileCookieDialog from './BrowserProfileCookieDialog'
import { deleteBrowserProfile, duplicateBrowserProfile, exportProfileCookies, updateBrowserProfile } from './browserProfileApi'
import { ProfileDot } from './browserProfile.list'
import { PROFILE_TEXT as T, profileErrorText } from './browserProfile.text'

type Mode = 'rename' | 'color' | 'cookies' | 'delete' | null

/** Save `text` as a downloaded file (the human export only; the server never sends it anywhere else). */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

export default function BrowserProfileRow({ profile: p, onChanged }: { profile: BrowserProfile; onChanged: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState(p.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDefault = p.isDefaultOf !== undefined

  const run = (job: Promise<unknown>, done?: () => void): void => {
    setBusy(true); setError(null)
    job.then(() => { done?.(); onChanged() }, (e: unknown) => setError(profileErrorText(e))).finally(() => setBusy(false))
  }
  const rename = (): void => {
    const v = validateProfileName(draft)
    if (!v.ok) { setError(T.errors.profile_name_invalid); return }
    if (v.name === p.name) { setMode(null); return }
    run(updateBrowserProfile(p.id, { name: v.name }), () => setMode(null))
  }
  const duplicateReason = p.live ? T.duplicateLive : undefined
  const deleteReason = isDefault ? T.deleteDefault : p.nodeCount > 0 ? T.deleteInUse(p.nodeCount) : undefined
  const items: VscodeMenuItem[] = [
    { type: 'item', id: 'rename', label: T.rename, onSelect: () => { setDraft(p.name); setError(null); setMode('rename') } },
    { type: 'item', id: 'color', label: T.recolor, onSelect: () => setMode('color') },
    { type: 'item', id: 'cookies', label: T.importCookies, onSelect: () => setMode('cookies') },
    { type: 'item', id: 'duplicate', label: T.duplicate, disabled: !!duplicateReason, title: duplicateReason, onSelect: () => run(duplicateBrowserProfile(p.id, T.duplicateName(p.name))) },
    { type: 'item', id: 'export', label: T.export, onSelect: () => run(exportProfileCookies(p.id).then((t) => download(`${p.name}.cookies.json`, t))) },
    { type: 'separator' },
    { type: 'item', id: 'delete', label: T.remove, danger: true, disabled: !!deleteReason, title: deleteReason, onSelect: () => setMode('delete') },
  ]

  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-profile-row={p.id}>
      <div className="flex items-center gap-2">
        <ProfileDot profile={p} />
        {mode === 'rename' ? (
          <form className="flex flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); rename() }}>
            <Input
              autoFocus aria-label={T.rename} value={draft} maxLength={BROWSER_PROFILE_NAME_MAX} disabled={busy} data-settings-escape
              onChange={(e) => { setDraft(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setMode(null); setError(null) } }}
            />
            <Button type="submit" size="xs" disabled={busy}>{T.save}</Button>
          </form>
        ) : (
          <span className="flex-1 truncate font-medium" title={p.name}>{p.name}</span>
        )}
        {isDefault && <span className="rounded border px-1 text-xs">{T.isDefault}</span>}
        {p.live && <span className="rounded border px-1 text-xs text-(--vscode-charts-green)">{T.live}</span>}
        <IconButton size="icon-xs" label={T.rowMenu(p.name)} aria-haspopup="menu" aria-expanded={menu !== null} disabled={busy}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right - 180, y: r.bottom }) }}>
          <span className="codicon codicon-kebab-vertical" aria-hidden="true" />
        </IconButton>
      </div>
      <p className="m-0 pl-[18px] text-xs text-(--vscode-descriptionForeground)">{T.usedBy(p.nodeCount)} · {T.cookieDomains(p.cookieDomains)}</p>
      {error && <p role="alert" className="m-0 pl-[18px] text-xs text-(--vscode-errorForeground)">{error}</p>}
      {menu && <VscodeMenu open anchor={menu} items={items} minWidth={180} ariaLabel={T.rowMenu(p.name)} onClose={() => setMenu(null)} />}
      {mode === 'color' && (
        <Dialog open onOpenChange={(o) => { if (!o) setMode(null) }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader><DialogTitle>{T.colorLabel}: {p.name}</DialogTitle></DialogHeader>
            <ProfileColorPicker value={{ color: p.color, shade: p.shade }} onChange={(c) => run(updateBrowserProfile(p.id, c))} />
            <div className="flex justify-end"><Button size="xs" onClick={() => setMode(null)}>Done</Button></div>
          </DialogContent>
        </Dialog>
      )}
      {mode === 'cookies' && <BrowserProfileCookieDialog profile={p} onClose={() => setMode(null)} onChanged={onChanged} />}
      {mode === 'delete' && (
        <AlertDialog open onOpenChange={(o) => { if (!o) setMode(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{T.confirmDelete(p.name)}</AlertDialogTitle>
              <AlertDialogDescription>{T.confirmDeleteBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{T.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => run(deleteBrowserProfile(p.id), () => setMode(null))}>{T.remove}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  )
}
