// Rename preview (VS Code's Refactor Preview, reduced to a list): every line the language server
// would change, before and after, in every file. Nothing is written until Apply.
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { answerRenamePreview, useRenamePreview } from './editorLsp.store'

export const RENAME_PREVIEW_TEXT = {
  title: (name: string) => `Rename to “${name}”`,
  summary: (changes: number, files: number) => `${changes} ${changes === 1 ? 'change' : 'changes'} in ${files} ${files === 1 ? 'file' : 'files'}. Files not open in an editor are saved to disk.`,
  apply: 'Apply',
  cancel: 'Cancel',
} as const

/** The pending rename preview of editor node `nodeId`; renders nothing when there is none. */
export function EditorRenamePreview({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const p = useRenamePreview(nodeId)
  if (!p) return null
  const changes = p.files.reduce((n, f) => n + f.lines.length, 0)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) answerRenamePreview(false) }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" data-testid="rename-preview">
        <DialogHeader>
          <DialogTitle>{RENAME_PREVIEW_TEXT.title(p.newName)}</DialogTitle>
          <DialogDescription>{RENAME_PREVIEW_TEXT.summary(changes, p.files.length)}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-xs" aria-label="Rename changes">
          {p.files.map((f) => (
            <li key={f.path}>
              <div className="font-medium break-all">{f.path}</div>
              {f.lines.map((l) => (
                <div key={l.line} className="font-mono">
                  <div className="opacity-60"><span className="tabular-nums">{l.line}</span> <del>{l.before.trim()}</del></div>
                  <div><span className="tabular-nums opacity-60">{l.line}</span> <ins>{l.after.trim()}</ins></div>
                </div>
              ))}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={() => answerRenamePreview(false)}>{RENAME_PREVIEW_TEXT.cancel}</Button>
          <Button onClick={() => answerRenamePreview(true)}>{RENAME_PREVIEW_TEXT.apply}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
