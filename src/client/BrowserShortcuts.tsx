// Start-page shortcut grid, like Chrome's NTP: favicon tiles, a hover "⋮" (or right-click) for Edit / Remove,
// and an "Add shortcut" tile. The list persists per client (`browser.shortcuts.ts`).
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import BrowserFavicon from './browser.favicon'
import { cleanShortcut, loadShortcuts, putShortcut, removeShortcut, SHORTCUTS_MAX } from './browser.shortcuts'
import type { Shortcut } from './browser.startpage.data'
import { START_TEXT as T } from './browser.uxText'

type Editing = { id?: string; label: string; url: string }

/** Grid of shortcut tiles; `onGo(url)` navigates. */
export default function BrowserShortcuts({ onGo }: { onGo: (url: string) => void }) {
  const [list, setList] = useState(loadShortcuts)
  const [menu, setMenu] = useState<{ s: Shortcut; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const full = list.length >= SHORTCUTS_MAX
  const addTile = (
    <Button type="button" variant="ghost" className="browser-start-tile" disabled={full} onClick={() => setEditing({ label: '', url: '' })}>
      <span className="browser-start-icon browser-start-icon--add codicon codicon-add" aria-hidden="true" />
      <span className="browser-start-name">{T.add}</span>
    </Button>
  )

  return (
    <>
      <ul className="browser-start-grid" aria-label={T.shortcuts}>
        {list.map((s) => (
          <li key={s.id} className="browser-start-cell" onContextMenu={(e) => { e.preventDefault(); setMenu({ s, x: e.clientX, y: e.clientY }) }}>
            <Button type="button" variant="ghost" className="browser-start-tile" aria-label={T.open(s.label)} onClick={() => onGo(s.url)}>
              <BrowserFavicon className="browser-start-icon" url={s.url} label={s.label} color={s.color} />
              <span className="browser-start-name">{s.label}</span>
            </Button>
            <IconTooltip label={T.tileMenu(s.label)}>
              <button
                type="button" className="browser-start-tile-menu codicon codicon-kebab-vertical" aria-label={T.tileMenu(s.label)} aria-haspopup="menu"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ s, x: r.left, y: r.bottom }) }}
              />
            </IconTooltip>
          </li>
        ))}
        <li className="browser-start-cell">
          {full ? <IconTooltip label={T.full} disabled>{addTile}</IconTooltip> : addTile}
        </li>
      </ul>
      {menu && (
        <VscodeMenu open anchor={{ x: menu.x, y: menu.y }} ariaLabel={T.tileMenu(menu.s.label)} onClose={() => setMenu(null)} items={[
          { type: 'item', id: 'edit', label: `${T.edit}…`, onSelect: () => setEditing({ id: menu.s.id, label: menu.s.label, url: menu.s.url }) },
          { type: 'item', id: 'remove', label: T.remove, danger: true, onSelect: () => setList(removeShortcut(list, menu.s.id)) },
        ]} />
      )}
      {editing && (
        <ShortcutDialog initial={editing} onClose={() => setEditing(null)}
          onSave={(label, url) => { setList(putShortcut(list, label, url, editing.id)); setEditing(null) }} />
      )}
    </>
  )
}

/** Name + URL form (Chrome's "Add shortcut" / "Edit shortcut" dialog). */
function ShortcutDialog({ initial, onClose, onSave }: { initial: Editing; onClose: () => void; onSave: (label: string, url: string) => void }) {
  const [label, setLabel] = useState(initial.label)
  const [url, setUrl] = useState(initial.url)
  const [error, setError] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!cleanShortcut(label, url)) { setError(true); return }
    onSave(label, url)
  }
  const title = initial.id ? T.edit : T.add
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="nodrag nowheel nopan nokey">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={title}>
          <Label className="flex flex-col items-stretch gap-1">{T.nameLabel}
            <Input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} />
          </Label>
          <Label className="flex flex-col items-stretch gap-1">{T.urlLabel}
            <Input value={url} type="text" inputMode="url" spellCheck={false} aria-invalid={error}
              aria-describedby={error ? 'browser-shortcut-error' : undefined} onChange={(e) => { setUrl(e.target.value); setError(false) }} />
          </Label>
          {error && <p id="browser-shortcut-error" role="alert" className="m-0 text-xs text-(--vscode-errorForeground)">{T.badUrl}</p>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{T.cancel}</Button>
            <Button type="submit" disabled={!url.trim()}>{T.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
