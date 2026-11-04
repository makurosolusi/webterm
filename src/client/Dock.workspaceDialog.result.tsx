import { Button } from '@/components/ui/button'
import type { CreatedWorktree } from './workspaceWorktree.api'

/** After "Create": where the worktree went, what `.worktreeinclude` copied/skipped, and the setup log. */
export function WorktreeResult({ result, onClose }: { result: CreatedWorktree; onClose: () => void }) {
  const { setup, includes } = result
  const setupLine = !setup.ran ? 'No setup script ran.'
    : setup.timedOut ? `Setup from ${setup.source} timed out.`
      : setup.ok ? `Setup from ${setup.source} finished.` : `Setup from ${setup.source} failed (exit ${setup.exitCode}).`
  return (
    <div className="dock-menu__form">
      <div>Branch <code>{result.branch}</code> from <code>{result.base}</code> at <code>{result.path}</code></div>
      {includes.copied.length > 0 && <div>Copied: {includes.copied.join(', ')}</div>}
      {includes.skipped.length > 0 && <div role="note">Skipped: {includes.skipped.join('; ')}</div>}
      <div role={setup.ran && !setup.ok ? 'alert' : undefined}>{setupLine}</div>
      {setup.output && (
        <pre aria-label="Setup output" className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px]">{setup.output}</pre>
      )}
      <Button autoFocus onClick={onClose}>Close</Button>
    </div>
  )
}
