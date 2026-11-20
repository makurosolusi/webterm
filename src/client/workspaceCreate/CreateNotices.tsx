// What the two dialogs show around Create / Clone: the resolved target path, the preflight notice
// that needs a decision (already cloned / name taken / wrong place), and the success state.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { writeClipboard } from '../clipboard'
import { joinPath } from '../FolderPicker'
import type { Notice } from './useCreateFlow'
import { revealPath } from './workspaceCreate.api'
import { CREATE_TEXT } from './workspaceCreate.labels'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const MAX_SHOWN_PATH = 56

/** Shortens a long path to head…tail so the folder name stays readable; short paths are untouched. */
export function middleEllipsis(path: string, max = MAX_SHOWN_PATH): string {
  if (path.length <= max) return path
  const tail = Math.ceil((max - 1) * 0.6)
  return `${path.slice(0, max - 1 - tail)}…${path.slice(path.length - tail)}`
}

/** Full path the folder will get, muted and middle-shortened when long (full text in title + screen readers). */
export function TargetPath({ parent, name }: { parent: string; name: string }): React.JSX.Element | null {
  if (!parent.trim() || !name.trim()) return null
  const full = joinPath(parent.trim(), name.trim())
  const shown = middleEllipsis(full)
  return (
    <p className="m-0 text-[length:var(--bui-font-sm,12px)] leading-4 text-(--vscode-descriptionForeground) [overflow-wrap:anywhere]" data-testid="target-path">
      {CREATE_TEXT.hint.prefix} <code title={full}>{shown}</code>
      {shown !== full && <span className="sr-only"> ({full})</span>}
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
    <div className="flex flex-col gap-2 rounded border border-(--vscode-inputValidation-warningBorder) bg-(--vscode-inputValidation-warningBackground) p-2" role="status" data-testid={`notice-${notice.kind}`}>
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

/** Success state: where it went, Reveal in Finder, Copy path; `bootstrapIdentity` says who authored the first commit. */
export function CreatedPanel({ path, onDone, bootstrapIdentity = false }: { path: string; onDone: () => void; bootstrapIdentity?: boolean }): React.JSX.Element {
  const [note, setNote] = useState('')
  const reveal = (): void => { void revealPath(path).then(() => setNote(''), (e) => setNote(errText(e))) }
  const copy = (): void => { void writeClipboard(path).then((ok) => setNote(ok ? CREATE_TEXT.created.copied : CREATE_TEXT.created.copyFailed)) }
  return (
    <div className="flex flex-col gap-4 text-xs" data-testid="created-panel">
      <p className="m-0 [overflow-wrap:anywhere]">{CREATE_TEXT.created.opened} <code>{path}</code></p>
      {bootstrapIdentity && (
        <p className="m-0 flex items-start gap-2 text-(--vscode-descriptionForeground)" role="status" data-testid="bootstrap-identity-note">
          <span className="codicon codicon-info mt-px" aria-hidden />
          <span>{CREATE_TEXT.bootstrapIdentity}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={reveal}>{CREATE_TEXT.created.reveal}</Button>
        <Button type="button" size="sm" variant="outline" onClick={copy}>{CREATE_TEXT.created.copy}</Button>
        <Button type="button" size="sm" onClick={onDone}>{CREATE_TEXT.created.done}</Button>
      </div>
      <p className="m-0 min-h-4 opacity-80" role="status" aria-live="polite">{note}</p>
    </div>
  )
}
