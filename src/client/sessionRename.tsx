// Rename prompt of a Sessions side bar row (hover action, ⋯ menu "Rename…"). A small dialog rather
// than an inline field: the row lives inside `vscode-tree`, whose host swallows Enter/Space/letters
// for selection and type-ahead. Enter saves, Escape cancels; an empty or unchanged name saves nothing.
import { useRef, useState } from 'react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'

export interface RenameTarget { id: string; label: string; title: string }

export function SessionRenameDialog({ target, onRename, onClose }: {
  target: RenameTarget
  onRename: (id: string, title: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(target.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const save = () => {
    const next = draft.trim()
    if (next && next !== target.title) onRename(target.id, next)
    onClose()
  }
  const ok = <Button key="save" onClick={save}>Rename</Button>
  const cancel = <Button key="cancel" variant="secondary" onClick={onClose}>Cancel</Button>
  return (
    <VscodeDialog
      open onOpenChange={(open) => { if (!open) onClose() }}
      title={`Rename “${target.label}”`} width={420} initialFocus={inputRef}
      footer={arrangeDialogButtons([ok, cancel], 1)}
    >
      <Input
        ref={inputRef}
        aria-label="Session name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
      />
    </VscodeDialog>
  )
}
