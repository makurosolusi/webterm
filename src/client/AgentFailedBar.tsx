import { Button } from '@/components/ui/button'

export const AGENT_FAILED_TEXT = {
  message: 'The agent failed to start or exited with an error. See the terminal for the cause.',
  retry: 'Retry',
}

export const AGENT_ENDED_TEXT = {
  message: 'Session ended.',
  resume: 'Resume',
  resumeHint: 'Continue this conversation in a new process.',
  newSession: 'New session',
}

/** Bar shape shared by the lifecycle bars: in the body's flow under the terminal, never over its last rows. */
const BAR = 'nodrag flex flex-none items-center gap-2 border-t px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground)'

/**
 * Sticky error for an agent whose open failed or that exited non-zero (agent-211-A1/A2). It sits at
 * the foot of the node so the cause printed at the top of the terminal stays readable. The node
 * never replays a failed open by itself (the exit frame stops that); only this Retry opens again.
 */
export function AgentFailedBar({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className={`${BAR} border-(--vscode-inputValidation-errorBorder)`} data-bar="failed">
      <span className="codicon codicon-error text-(--vscode-errorForeground)" aria-hidden />
      <span className="flex-1">{AGENT_FAILED_TEXT.message}</span>
      <Button size="xs" variant="secondary" onClick={onRetry}>
        {AGENT_FAILED_TEXT.retry}
      </Button>
    </div>
  )
}

/**
 * After a normal exit (VS Code "Terminal process terminated… Relaunch", Claude Code extension "Resume"):
 * Resume continues the conversation when it can be resumed, New session starts over.
 */
export function AgentEndedBar({ onResume, onNewSession }: { onResume?: () => void; onNewSession: () => void }) {
  return (
    <div role="status" className={`${BAR} border-(--vscode-widget-border)`} data-bar="ended">
      <span className="codicon codicon-debug-disconnect opacity-80" aria-hidden />
      <span className="flex-1">{AGENT_ENDED_TEXT.message}</span>
      {onResume && <Button size="xs" variant="default" onClick={onResume}>{AGENT_ENDED_TEXT.resume}</Button>}
      <Button size="xs" variant="secondary" onClick={onNewSession}>{AGENT_ENDED_TEXT.newSession}</Button>
    </div>
  )
}
