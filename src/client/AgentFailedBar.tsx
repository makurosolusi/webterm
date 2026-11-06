import { Button } from '@/components/ui/button'

export const AGENT_FAILED_TEXT = {
  message: 'The agent failed to start or exited with an error. See the terminal for the cause.',
  retry: 'Retry',
}

/**
 * Sticky error for an agent whose open failed or that exited non-zero (agent-211-A1/A2). It sits at
 * the foot of the node so the cause printed at the top of the terminal stays readable. The node
 * never replays a failed open by itself (the exit frame stops that); only this Retry opens again.
 */
export function AgentFailedBar({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="nodrag absolute bottom-2 right-2 left-2 z-10 flex items-center gap-2 rounded px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-inputValidation-errorBorder)"
    >
      <span className="codicon codicon-error text-(--vscode-errorForeground)" aria-hidden />
      <span className="flex-1">{AGENT_FAILED_TEXT.message}</span>
      <Button size="xs" variant="secondary" onClick={onRetry}>
        {AGENT_FAILED_TEXT.retry}
      </Button>
    </div>
  )
}
