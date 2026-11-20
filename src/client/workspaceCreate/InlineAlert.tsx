// Structured inline error for the create dialogs: icon + short text (server messages carry `code`
// spans as backticks, rendered as <code>), announced as an alert, optional action.
import { Alert, AlertDescription } from '@/components/ui/alert'

/** Splits `a \`b\` c` into text and <code> parts; no backtick ever reaches the screen. */
export function InlineCode({ text }: { text: string }): React.JSX.Element {
  const parts = text.split('`')
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : p))}</>
}

export function InlineAlert({ message, action, testId }: { message: string; action?: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <Alert variant="destructive" className="items-center" data-testid={testId ?? 'inline-alert'}>
      <span className="codicon codicon-error" aria-hidden />
      <AlertDescription className="text-foreground [overflow-wrap:anywhere]"><InlineCode text={message} /></AlertDescription>
      {action && <div className="col-start-2 mt-1">{action}</div>}
    </Alert>
  )
}
