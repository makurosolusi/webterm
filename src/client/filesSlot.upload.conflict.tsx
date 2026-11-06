// "Already exists" prompt of an upload (VS Code file-conflict dialog): Replace / Keep Both / Skip, plus
// "Apply to all remaining conflicts" when more files are queued. One pending question per node; the
// upload queue awaits the answer. Closing the dialog (Esc) answers Skip, so nothing is overwritten.
import { useId, useState, useSyncExternalStore } from 'react'
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { folderTitle } from './fileBrowse'
import type { ConflictAnswer, ConflictAsk, ConflictChoice } from './uploadQueue'

export const CONFLICT_TEXT = {
  title: (name: string, folder: string) => `‘${name}’ already exists in ‘${folder}’. Replace it?`,
  body: 'Replacing it will overwrite its current contents. This action is irreversible!',
  replace: 'Replace',
  keep: 'Keep Both',
  skip: 'Skip',
  applyAll: 'Apply to all remaining conflicts',
} as const

interface Pending { seq: number; ask: ConflictAsk; resolve(a: ConflictAnswer): void }
const pendingBy = new Map<string, Pending>()
const subs = new Set<() => void>()
let seq = 0
const emit = () => { subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

/** Ask node `nodeId` how to resolve a name conflict; resolves when the user answers. */
export function askConflict(nodeId: string, ask: ConflictAsk): Promise<ConflictAnswer> {
  return new Promise((resolve) => { pendingBy.set(nodeId, { seq: ++seq, ask, resolve }); emit() })
}

function answer(nodeId: string, a: ConflictAnswer): void {
  const p = pendingBy.get(nodeId)
  if (!p) return
  pendingBy.delete(nodeId)
  emit()
  p.resolve(a)
}

/** Answer node `nodeId`'s pending question Skip (its node is gone), so its upload never hangs. */
export const skipUploadConflict = (nodeId: string): void => answer(nodeId, { choice: 'skip', all: false })

/** Reset the module state (tests); a pending question is answered Skip so no upload hangs. */
export function resetUploadConflicts(): void {
  for (const id of [...pendingBy.keys()]) skipUploadConflict(id)
}

function ConflictDialog({ nodeId, ask }: { nodeId: string; ask: ConflictAsk }) {
  const [all, setAll] = useState(false)
  const boxId = useId()
  const pick = (choice: ConflictChoice) => answer(nodeId, { choice, all })
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) pick('skip') }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{CONFLICT_TEXT.title(ask.name, folderTitle(ask.dir))}</AlertDialogTitle>
          <AlertDialogDescription>{CONFLICT_TEXT.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {ask.remaining > 0 && (
          <div className="flex items-center gap-2 px-3">
            <Checkbox id={boxId} checked={all} onCheckedChange={(v) => setAll(v === true)} />
            <Label htmlFor={boxId}>{CONFLICT_TEXT.applyAll}</Label>
          </div>
        )}
        <AlertDialogFooter>
          <Button type="button" onClick={() => pick('replace')}>{CONFLICT_TEXT.replace}</Button>
          <Button type="button" variant="secondary" onClick={() => pick('keep')}>{CONFLICT_TEXT.keep}</Button>
          <Button type="button" variant="secondary" onClick={() => pick('skip')}>{CONFLICT_TEXT.skip}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The pending conflict question of node `nodeId`, or nothing. */
export function UploadConflictDialog({ nodeId }: { nodeId: string }) {
  const p = useSyncExternalStore(subscribe, () => pendingBy.get(nodeId))
  // `key` = question: the "apply to all" checkbox starts unchecked for every new question.
  return p ? <ConflictDialog key={p.seq} nodeId={nodeId} ask={p.ask} /> : null
}
