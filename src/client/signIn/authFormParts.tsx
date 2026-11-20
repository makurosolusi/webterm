// Shared pieces of the sign-in and setup forms: the alert above the submit button, the submit
// button with its in-flight spinner, and the live password requirement checklist.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SIGN_IN_TEXT } from '../signInLabels'

export const causeOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Counter a form bumps to move focus into its alert (screen readers then read it); pass the value as FormAlert `grab`. */
export function useAlertGrab(): [number, () => void] {
  const [n, setN] = useState(0)
  return [n, () => setN((v) => v + 1)]
}

/** Server, network or rate-limit sentence, announced at once; nothing when `text` is null. Focus moves here whenever `grab` changes. */
export function FormAlert({ text, grab = 0 }: { text: string | null; grab?: number }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (grab > 0) ref.current?.focus() }, [grab])
  if (!text) return null
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="flex min-w-0 max-w-full outline-none items-start gap-2 rounded-(--vscode-cornerRadius-small) border border-[var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))] bg-[var(--vscode-inputValidation-errorBackground,transparent)] px-3 py-2 text-[13px] text-[var(--vscode-errorForeground)]">
      <span className="codicon codicon-error mt-px shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  )
}

export interface SubmitButtonProps {
  label: string
  pendingLabel: string
  pending: boolean
  /** Only while a 429 counts down; the FormAlert above says until when. */
  blocked: boolean
  /** Setup only: stays off until every field is valid; the sign-in submit stays enabled to explain what is missing. */
  disabled?: boolean
}

/** Full-width primary submit; stays enabled for invalid input so the submit can show the errors. */
export function SubmitButton({ label, pendingLabel, pending, blocked, disabled }: SubmitButtonProps): React.JSX.Element {
  return (
    <Button type="submit" className="h-11 w-full text-base" disabled={blocked || disabled} aria-disabled={pending || undefined} aria-busy={pending || undefined}>
      {pending ? <><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{pendingLabel}</> : label}
    </Button>
  )
}

export interface Requirement { label: string; met: boolean }

/** Live checklist of password rules; each item turns into a check once met. */
export function PasswordChecklist({ id, items }: { id: string; items: Requirement[] }): React.JSX.Element {
  return (
    <ul id={id} aria-label={SIGN_IN_TEXT.requirements} aria-live="polite" className="flex min-w-0 flex-col gap-1 text-[13px] leading-4 break-words">
      {items.map(({ label, met }) => (
        <li key={label} data-met={met} className="sign-in-check flex items-center gap-1.5">
          <span className={`codicon codicon-${met ? 'check' : 'dash'}`} aria-hidden="true" />
          {label}<span className="sr-only"> {met ? SIGN_IN_TEXT.checkMet : SIGN_IN_TEXT.checkPending}</span>
        </li>
      ))}
    </ul>
  )
}
