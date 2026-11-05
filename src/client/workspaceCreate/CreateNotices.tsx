// What the two dialogs show around Create / Clone: the resolved target path, the preflight notice
// that needs a decision (already cloned / name taken / wrong place), and the success state.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { writeClipboard } from '../clipboard'
import { joinPath } from '../FolderPicker'
import type { Notice } from './useCreateFlow'
import { revealPath } from './workspaceCreate.api'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Full path the folder will get, shown before anything is created. */
export function TargetPath({ parent, name }: { parent: string; name: string }): React.JSX.Element | null {
  if (!parent.trim() || !name.trim()) return null
  return (
    <p className="m-0 opacity-80 [overflow-wrap:anywhere]" data-testid="target-path">
      Will be created at <code>{joinPath(parent.trim(), name.trim())}</code>
    </p>
  )
}

export function CreateNotice({ notice, verb, onOpenExisting, onUseName, onProceed }: {
  notice: Notice
  /** "Clone" / "Create" for the "anyway" buttons. */
  verb: string
  /** Clone only: preflight never reports an existing clone without a URL. */
  onOpenExisting?: () => void
  onUseName: (name: string) => void
  onProceed: (ack: { existing?: boolean; warnings?: boolean }) => void
}): React.JSX.Element {
  const { pre } = notice
  const name = pre.target.split('/').pop() ?? ''
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-500/50 p-2" role="status" data-testid={`notice-${notice.kind}`}>
      {notice.kind === 'existing' && pre.existing && onOpenExisting && (
        <>
          <p className="m-0 [overflow-wrap:anywhere]">Already cloned at <code>{pre.existing.path}</code> — Open it?</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onOpenExisting}>Open</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onProceed({ existing: true })}>{verb} again anyway</Button>
          </div>
        </>
      )}
      {notice.kind === 'taken' && (
        <>
          <p className="m-0"><code>{name}</code> already exists here.</p>
          {pre.suggestion && (
            <div><Button type="button" size="sm" onClick={() => onUseName(pre.suggestion as string)}>Use {pre.suggestion}</Button></div>
          )}
        </>
      )}
      {(notice.kind === 'warn' || notice.kind === 'blocked') && (
        <>
          {pre.warnings.filter((w) => notice.kind === 'warn' || w.blocking).map((w) => <p key={w.code} className="m-0 [overflow-wrap:anywhere]">{w.message}</p>)}
          {notice.kind === 'warn' && (
            <div><Button type="button" size="sm" variant="outline" onClick={() => onProceed({ warnings: true })}>{verb} anyway</Button></div>
          )}
        </>
      )}
    </div>
  )
}

/** Success state: where it went, Reveal in Finder, Copy path. */
export function CreatedPanel({ path, onDone }: { path: string; onDone: () => void }): React.JSX.Element {
  const [note, setNote] = useState('')
  const reveal = (): void => { void revealPath(path).then(() => setNote(''), (e) => setNote(errText(e))) }
  const copy = (): void => { void writeClipboard(path).then((ok) => setNote(ok ? 'Path copied.' : 'Could not copy the path.')) }
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="created-panel">
      <p className="m-0 [overflow-wrap:anywhere]">Opened as a workspace: <code>{path}</code></p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={reveal}>Reveal in Finder</Button>
        <Button type="button" size="sm" variant="outline" onClick={copy}>Copy path</Button>
        <Button type="button" size="sm" onClick={onDone}>Done</Button>
      </div>
      {note && <p className="m-0 opacity-80" role="status">{note}</p>}
    </div>
  )
}
