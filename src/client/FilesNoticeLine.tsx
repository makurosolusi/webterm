// Renders the Files node notice store (`filesNotice.ts`): the footer line (latest notice, or the
// fallback count) and the thin determinate progress bar on top of the list (VS Code view progress).
// Named apart from the store on purpose: `./FilesNotice` would resolve to `filesNotice.ts` on macOS.
import { IconButton } from './components/ui/icon-button'
import { dismissNotice, useFilesNotices } from './filesNotice'

export const NOTICE_TEXT = { dismiss: 'Dismiss', cancel: 'Cancel' } as const

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

/** Footer text: the latest notice with its actions, or `fallback` when there is none. */
export function FilesNoticeLine({ nodeId, fallback }: { nodeId: string; fallback: string }) {
  const list = useFilesNotices(nodeId)
  const n = list[list.length - 1]
  if (!n) return <span className="files-foot-text">{fallback}</span>
  return (
    <>
      <span className={`files-foot-text files-notice--${n.kind}`} title={n.detail}>{n.text}</span>
      {n.actions?.map((a) => (
        <IconButton key={a.label} type="button" size="icon-sm" className="files-tool" label={a.label} onClick={a.run}>{icon(a.icon)}</IconButton>
      ))}
      {n.kind === 'progress' && n.onCancel && (
        <IconButton type="button" size="icon-sm" className="files-tool" label={NOTICE_TEXT.cancel} onClick={n.onCancel}>{icon('close')}</IconButton>
      )}
      {n.kind === 'error' && (
        <IconButton type="button" size="icon-sm" className="files-tool" label={NOTICE_TEXT.dismiss} onClick={() => dismissNotice(nodeId, n.id)}>{icon('close')}</IconButton>
      )}
    </>
  )
}

/** Thin progress line for the first notice that carries a `progress` ratio; nothing otherwise. */
export function FilesProgressBar({ nodeId }: { nodeId: string }) {
  const p = useFilesNotices(nodeId).find((n) => n.kind === 'progress' && n.progress !== undefined)
  if (!p) return null
  const pct = Math.round(Math.min(1, Math.max(0, p.progress ?? 0)) * 100)
  return (
    <div className="files-progress" role="progressbar" aria-label={p.text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="files-progress-bit" style={{ width: `${pct}%` }} />
    </div>
  )
}
