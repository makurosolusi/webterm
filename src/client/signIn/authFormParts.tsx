// Shared pieces of the sign-in and setup forms: the alert above the submit button, the submit
// button with its in-flight spinner, and the live password requirement checklist.
import { Button } from '@/components/ui/button'
import { SIGN_IN_TEXT } from '../signInLabels'

export const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Server, network or rate-limit sentence, announced at once; nothing when `text` is null. */
export function FormAlert({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return (
    <div role="alert" className="flex items-start gap-2 rounded-(--vscode-cornerRadius-small) border border-[var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))] bg-[var(--vscode-inputValidation-errorBackground,transparent)] px-3 py-2 text-xs text-[var(--vscode-errorForeground)]">
      <span className="codicon codicon-error mt-px shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

export interface SubmitButtonProps {
  label: string
  pendingLabel: string
  pending: boolean
  /** Only while a 429 counts down; the FormAlert above says until when. */
  blocked: boolean
}

/** Full-width primary submit; stays enabled for invalid input so the submit can show the errors. */
export function SubmitButton({ label, pendingLabel, pending, blocked }: SubmitButtonProps): React.JSX.Element {
  return (
    <Button type="submit" className="h-8 w-full" disabled={blocked} aria-disabled={pending || undefined} aria-busy={pending || undefined}>
      {pending ? <><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{pendingLabel}</> : label}
    </Button>
  )
}

export interface Requirement { label: string; met: boolean }

/** Live checklist of password rules; each item turns into a check once met. */
export function PasswordChecklist({ id, items }: { id: string; items: Requirement[] }): React.JSX.Element {
  return (
    <ul id={id} aria-label={SIGN_IN_TEXT.requirements} className="flex flex-col gap-1 text-xs">
      {items.map(({ label, met }) => (
        <li key={label} data-met={met} className="sign-in-check flex items-center gap-1.5">
          <span className={`codicon codicon-${met ? 'pass-filled' : 'circle-large'}`} aria-hidden="true" />
          {label}<span className="sr-only"> {met ? SIGN_IN_TEXT.checkMet : SIGN_IN_TEXT.checkPending}</span>
        </li>
      ))}
    </ul>
  )
}
