// What App shows until the workspace list is loaded (ui-210-3): a quiet loading line, or the boot
// failure with its cause and a Retry; never a blank page. Auto-retry keeps running behind it.
import { Button } from '@/components/ui/button'
import type { BootState } from './workspaceLifecycle.boot'

export const BOOT_LOADING_TEXT = 'Loading workspaces…'
export const BOOT_FAILED_TITLE = 'Could not load workspaces'

export default function BootScreen({ boot, onRetry }: { boot: BootState; onRetry: () => void }) {
  if (boot.kind !== 'error') {
    return (
      <div role="status" className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--vscode-descriptionForeground)]">
        {BOOT_LOADING_TEXT}
      </div>
    )
  }
  return (
    <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--vscode-editor-background)] text-foreground">
      <div className="text-[13px] font-semibold">{BOOT_FAILED_TITLE}</div>
      <div className="max-w-[480px] text-center text-xs text-[var(--vscode-errorForeground)]">{boot.message}</div>
      <div className="text-xs text-[var(--vscode-descriptionForeground)]">Retrying automatically.</div>
      <Button type="button" onClick={onRetry}>Retry</Button>
    </div>
  )
}
