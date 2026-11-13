// "Automation token" row (Settings › Claude › Advanced): the root token for scripts, MCP clients and agents.
// Status in plain words, enable/rotate through the UI after the app AlertDialog (the POST routes accept only
// the webterm page, approvalAuth.ts). Pattern: Orca RuntimePairingUrlGenerator.tsx:168-176 (clearGeneratedUrls),
// :178-249 (generate, rotate: true), :301-325 (copyGeneratedUrl): mint -> show once + Copy -> clear.
// People do not sign in with it (they use their account), so the card shows the bare value, never a
// sign-in link. The server keeps this tab signed in and signs every other browser out. The value lives
// only in component state: never in a log or storage, gone when the card closes.
import { useEffect, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Input } from '@/components/ui/input'
import { Field } from './SettingsFieldRow'
import { SettingsMessage } from './SettingsMessage'
import type { TokenStatus } from './tokenAccess.api.client'
import { enableToken, fetchTokenStatus, rotateToken, tokenErrorText } from './tokenAccess.api.client'
import { TOKEN_TEXT } from './tokenAccessLabels'

interface Question { title: string; body: string; action: string }

function statusText(s: TokenStatus): string {
  if (!s.enforced) return TOKEN_TEXT.off
  return s.source === 'env' ? TOKEN_TEXT.onEnv : TOKEN_TEXT.onFile
}

/** Automation token row; loads the status and shows a freshly minted token once. */
export function TokenAccessCard(): React.JSX.Element {
  const [status, setStatus] = useState<TokenStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [value, setValue] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean | null>(null)
  const [asking, setAsking] = useState<{ q: Question; answer(ok: boolean): void } | null>(null)

  const load = (): void => {
    setError(null)
    fetchTokenStatus().then((s) => setStatus(s), () => setError(TOKEN_TEXT.loadFailed))
  }
  useEffect(load, [])

  /** The dialog's answer; Cancel, Escape and a click outside are all "no". */
  const ask = (q: Question): Promise<boolean> => new Promise((resolve) => {
    setAsking({ q, answer: (ok) => { setAsking(null); resolve(ok) } })
  })
  /** Asks, then mints; resolves false when the user declined. The value goes to state only, never to the result line. */
  const minted = (mint: () => Promise<string>, q: Question) => async (): Promise<boolean> => {
    if (!(await ask(q))) return false
    try {
      setValue(await mint())
      setCopied(null)
      return true
    } finally {
      load()
    }
  }
  const resultOpts = { success: (ok: boolean) => (ok ? TOKEN_TEXT.shownBelow : TOKEN_TEXT.unchanged), failure: tokenErrorText }
  const enable = useAction(minted(enableToken, TOKEN_TEXT.confirmEnable), { label: TOKEN_TEXT.enable, ...resultOpts })
  const rotate = useAction(minted(rotateToken, TOKEN_TEXT.confirmRotate), { label: TOKEN_TEXT.rotate, ...resultOpts })

  const copy = (): void => {
    // No Clipboard API outside a secure context (http on another address): show the manual-copy hint.
    if (value === null) return
    if (!navigator.clipboard) return setCopied(false)
    navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))
  }

  return (
    <section aria-label={TOKEN_TEXT.title} data-slot="token-access">
      <Field label={TOKEN_TEXT.title} hint={TOKEN_TEXT.intro} block>
        {status === null && error === null ? <SettingsMessage kind="loading">{TOKEN_TEXT.loading}</SettingsMessage> : null}
        {error ? <SettingsMessage kind="error" action={{ label: TOKEN_TEXT.retry, run: load }}>{error}</SettingsMessage> : null}
        {status ? <p role="status" className="m-0 text-[13px]">{statusText(status)}</p> : null}
        {status && !status.enforced ? <p className="st-hint m-0">{TOKEN_TEXT.why}</p> : null}
        {status && !status.enforced && !status.canEnable ? <p className="st-hint m-0">{TOKEN_TEXT.offRemote}</p> : null}
        {value === null && (status?.canEnable || (status?.enforced && status.source === 'file')) ? (
          <span className="flex flex-wrap items-center gap-2">
            {status.canEnable ? <ActionButton size="sm" disabled={rotate.busy} action={enable} busyLabel={TOKEN_TEXT.enabling}>{TOKEN_TEXT.enable}</ActionButton> : null}
            {status.enforced && status.source === 'file'
              ? <ActionButton variant="outline" size="sm" disabled={enable.busy} action={rotate} busyLabel={TOKEN_TEXT.rotating}>{TOKEN_TEXT.rotate}</ActionButton> : null}
          </span>
        ) : null}
        <ActionResult action={enable} />
        <ActionResult action={rotate} />
        {value !== null ? (
          <span className="flex flex-col gap-2">
            <p className="m-0 text-[13px]">{TOKEN_TEXT.valueIntro}</p>
            <span className="flex items-center gap-2">
              <Input className="st-input st-mono flex-1" aria-label={TOKEN_TEXT.valueLabel} readOnly value={value} autoComplete="off" spellCheck={false} onFocus={(e) => e.target.select()} />
              <Button variant="outline" size="sm" onClick={copy}>{copied ? TOKEN_TEXT.copied : TOKEN_TEXT.copy}</Button>
              <Button size="sm" onClick={() => setValue(null)}>{TOKEN_TEXT.done}</Button>
            </span>
            {copied === false ? <p role="alert" className="st-hint m-0 text-destructive">{TOKEN_TEXT.copyFailed}</p> : null}
          </span>
        ) : null}
      </Field>
      {asking ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) asking.answer(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{asking.q.title}</AlertDialogTitle>
              <AlertDialogDescription>{asking.q.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{TOKEN_TEXT.cancel}</AlertDialogCancel>
              <AlertDialogAction onClick={() => asking.answer(true)}>{asking.q.action}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  )
}
