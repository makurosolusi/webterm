// "Compare" from the conflict bar, like VS Code's "file changed on disk → Compare": the disk version
// (left) against the unsaved buffer (right) in the read-only Monaco diff editor the Diff node uses.
// An overlay over the live editor, like the Markdown preview, so the buffer and its undo stay intact.
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { useDiffEditor, type DiffSides } from './DiffNode.editor'

const NO_NOTES: readonly number[] = []

export function EditorCompare({ fileName, load, onClose }: { fileName: string; load: () => Promise<DiffSides>; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [sides, setSides] = useState<DiffSides | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    load().then(
      (s) => { if (live) setSides(s) },
      (e: unknown) => { if (live) setError(`Couldn’t read ${fileName} from disk: ${e instanceof Error ? e.message : String(e)}`) },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one snapshot per open; reopening compares again
  }, [])
  const diff = useDiffEditor(host, sides, NO_NOTES)
  const failure = error || diff.error
  return (
    <div className="editor-node__md editor-node__compare nodrag nowheel nokey" role="region" aria-label={`Compare ${fileName}`}>
      <div className="editor-node__md-bar">
        <span>{fileName} (on disk) ↔ {fileName} (yours)</span>
        <IconButton size="icon-xs" label="Close Compare" onClick={onClose}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </IconButton>
      </div>
      {failure ? <span className="editor-node__notice" role="alert">{failure}</span> : !sides && <span className="editor-node__notice">Loading…</span>}
      <div className="editor-node__compare-host" ref={host} />
    </div>
  )
}
