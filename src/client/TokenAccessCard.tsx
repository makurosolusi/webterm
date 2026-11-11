// "Automation token" card (Settings › Capabilities): the root token for scripts, MCP clients and agents.
// Status in plain words, enable/rotate through the UI (the POST routes accept only the webterm page,
// approvalAuth.ts). Pattern: Orca RuntimePairingUrlGenerator.tsx:168-176 (clearGeneratedUrls),
// :178-249 (generate, rotate: true), :301-325 (copyGeneratedUrl): mint -> show once + Copy -> clear.
// People do not sign in with it (they use their account), so the card shows the bare value, never a
// sign-in link. The server keeps this tab signed in and signs every other browser out. The value lives
// only in component state: never in a log or storage, gone when the card closes.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TokenStatus } from './tokenAccess.api.client'
import { enableToken, fetchTokenStatus, rotateToken, tokenErrorText } from './tokenAccess.api.client'
import { TOKEN_TEXT } from './tokenAccessLabels'

function statusText(s: TokenStatus): string {
  if (!s.enforced) return TOKEN_TEXT.off
  return s.source === 'env' ? TOKEN_TEXT.onEnv : TOKEN_TEXT.onFile
}

/** Automation token card; loads the status and shows a freshly minted token once. */
export function TokenAccessCard(): React.JSX.Element {
  const [status, setStatus] = useState<TokenStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean | null>(null)

  const load = (): void => {
    fetchTokenStatus().then((s) => setStatus(s), () => setError(TOKEN_TEXT.loadFailed))
  }
  useEffect(load, [])

  const run = async (mint: () => Promise<string>, question: string): Promise<void> => {
    if (!window.confirm(question)) return
    setBusy(true)
    setError(null)
    try {
      setValue(await mint())
      setCopied(null)
    } catch (e) {
      setError(tokenErrorText(e))
    } finally {
      setBusy(false)
      load()
    }
  }

  const copy = (): void => {
    // No Clipboard API outside a secure context (http on another address): show the manual-copy hint.
    if (value === null) return
    if (!navigator.clipboard) return setCopied(false)
    navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))
  }

  return (
    <section aria-label={TOKEN_TEXT.title} className="flex flex-col gap-2">
      <h3>{TOKEN_TEXT.title}</h3>
      <p className="text-xs opacity-70">{TOKEN_TEXT.intro}</p>
      {status === null && error === null ? <p role="status" className="text-xs opacity-70">{TOKEN_TEXT.loading}</p> : null}
      {status ? <p role="status">{statusText(status)}</p> : null}
      {status && !status.enforced ? <p className="text-xs opacity-70">{TOKEN_TEXT.why}</p> : null}
      {status && !status.enforced && !status.canEnable ? <p className="text-xs opacity-70">{TOKEN_TEXT.offRemote}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {value === null && status?.canEnable ? (
        <Button size="sm" disabled={busy} onClick={() => void run(enableToken, TOKEN_TEXT.confirmEnable)}>{TOKEN_TEXT.enable}</Button>
      ) : null}
      {value === null && status?.enforced && status.source === 'file' ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(rotateToken, TOKEN_TEXT.confirmRotate)}>{TOKEN_TEXT.rotate}</Button>
      ) : null}
      {value !== null ? (
        <div className="flex flex-col gap-2">
          <p>{TOKEN_TEXT.valueIntro}</p>
          <div className="flex items-center gap-2">
            <Input aria-label={TOKEN_TEXT.valueLabel} readOnly value={value} autoComplete="off" spellCheck={false} onFocus={(e) => e.target.select()} />
            <Button variant="outline" size="sm" onClick={copy}>{copied ? TOKEN_TEXT.copied : TOKEN_TEXT.copy}</Button>
          </div>
          {copied === false ? <p role="alert" className="text-xs text-destructive">{TOKEN_TEXT.copyFailed}</p> : null}
          <Button size="sm" onClick={() => setValue(null)}>{TOKEN_TEXT.done}</Button>
        </div>
      ) : null}
    </section>
  )
}
