// Inline rename inside a workspace tab (VS Code / browser tab rename): Enter or blur saves,
// Escape cancels. While the save runs the input is read-only (`aria-busy`); a rejected save keeps
// the editor open with the cause, so the typed name is not lost.
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { normalizeWorkspaceName } from './workspaceMenu'

export interface WorkspaceTabRenameProps {
  /** Current name; also the initial draft. */
  initial: string
  /** Called with a normalized, changed name. A returned promise keeps the editor busy until it settles. */
  onCommit: (name: string) => void | Promise<unknown>
  /** Closes the editor (after a save, a no-op commit or Escape). */
  onClose: () => void
}

/** Text field that replaces a workspace tab's label while it is being renamed. */
export function WorkspaceTabRename({ initial, onCommit, onClose }: WorkspaceTabRenameProps) {
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  // Escape closes, then the unmounting input may still blur: that blur must not save.
  const settled = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const close = (): void => {
    settled.current = true
    onClose()
  }

  const commit = (): void => {
    if (busy || settled.current) return
    const name = normalizeWorkspaceName(draft)
    // Empty draft or unchanged name: close without writing (the PUT carries the whole board).
    if (!name || name === initial) return close()
    setBusy(true)
    setError(null)
    Promise.resolve(onCommit(name)).then(close, (err: unknown) => {
      setBusy(false)
      setError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  return (
    <span className="app-tab-rename">
      <Input
        ref={ref}
        className="app-tab-rename__input"
        value={draft}
        spellCheck={false}
        aria-label="Workspace name"
        aria-busy={busy}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        readOnly={busy}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') close()
        }}
        onBlur={commit}
      />
      {busy && <span className="codicon codicon-loading codicon-modifier-spin app-tab-rename__busy" aria-hidden />}
      {error && <span className="app-tab-rename__error" role="alert">{error}</span>}
    </span>
  )
}
