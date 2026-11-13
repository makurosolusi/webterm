// Body states of an editor node that replace the editor: still loading, and a read that failed or was
// refused (over the size cap). Like VS Code's error editor, a failure always offers a way out.
import { Button as VscodeButton, ProgressBar } from '@/vscode/register'
import { ActionResult, useAction } from '@/components/ui/action'
import { IconTooltip } from '@/components/ui/icon-button'
import { writeClipboard } from './clipboard'

/** Copy `text` to the clipboard, then say "Copied" (or that copying failed, with Retry). */
export function CopyText({ text, title, children }: { text: string; title: string; children: string }) {
  const act = useAction(() => writeClipboard(text), { label: children, ok: (r) => r, success: (r) => (r ? 'Copied' : 'Copy failed: the browser blocked the clipboard') })
  const click = (): void => { void act.run() }
  return (
    <>
      <IconTooltip label={title}>
        <VscodeButton secondary disabled={act.busy} aria-busy={act.busy ? 'true' : 'false'} onClick={click}>{children}</VscodeButton>
      </IconTooltip>
      <ActionResult action={act} />
    </>
  )
}

/** Thin indeterminate bar at the top of the body until the file is read and Monaco is up (VS Code's editor progress). */
export function EditorLoading() {
  return <ProgressBar className="editor-node__progress" indeterminate aria-label="Loading file" />
}

/** The read failed or was refused: the reason, Retry, Copy Path and (when a Files node opened it) Show in Files. */
export function EditorLoadFailure({ message, filePath, onRetry, onShowInFiles }: {
  message: string; filePath: string; onRetry: () => void; onShowInFiles: (() => void) | null
}) {
  return (
    <div className="editor-node__placeholder" role="alert">
      <span>{message}</span>
      <span className="editor-node__placeholder-actions">
        <VscodeButton onClick={onRetry}>Retry</VscodeButton>
        <CopyText text={filePath} title="Copy file path">Copy Path</CopyText>
        {onShowInFiles && <VscodeButton secondary onClick={onShowInFiles}>Show in Files</VscodeButton>}
      </span>
    </div>
  )
}
