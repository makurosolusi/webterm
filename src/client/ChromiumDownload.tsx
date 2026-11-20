// "Download Chromium" control used by the wizard Browser step:
// start, progress (polled while the server downloads), automatic retry notice, cancel, failed + Try again,
// done. The server installs webterm's managed Chrome (locked version, checksum-verified); nothing is saved as
// an override. `onDone` reloads the capabilities so the UI follows.
import { useEffect, useRef, useState } from 'react'
import { ActionButton, useAction } from '@/components/ui/action'
import type { ChromiumDownloadStatus } from '../shared/featureCapabilities'
import { DOWNLOAD_TEXT as T } from './advancedLabels'
import { chromiumDownload } from './capabilitiesApi'

/** Progress refresh while downloading; the server only keeps a counter, so polling is cheap. */
export const DOWNLOAD_POLL_MS = 500

export interface ChromiumDownloadProps {
  /** Called once a download this view watched finishes (reload capabilities). */
  onDone(): Promise<unknown> | void
  /** Every status the view shows (the wizard enables Continue on `done`). */
  onStatus?(status: ChromiumDownloadStatus): void
}

/** The download control with all its states; reads the server status on mount (a download may already run). */
export function ChromiumDownload({ onDone, onStatus }: ChromiumDownloadProps): React.JSX.Element {
  const [status, setStatus] = useState<ChromiumDownloadStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const cb = useRef({ onDone, onStatus })
  cb.current = { onDone, onStatus }
  const prev = useRef<ChromiumDownloadStatus['state'] | null>(null)

  const show = (s: ChromiumDownloadStatus): void => {
    if ((prev.current === 'downloading' || prev.current === 'retrying') && s.state === 'done') void cb.current.onDone()
    prev.current = s.state
    setStatus(s)
    setUnreachable(false)
    cb.current.onStatus?.(s)
  }
  const call = async (action: 'status' | 'start' | 'cancel'): Promise<void> => {
    try {
      show(await chromiumDownload(action))
    } catch (e) {
      console.warn('chromium download: request failed', action, e instanceof Error ? e.message : 'error')
      setUnreachable(true)
    }
  }
  // Busy per button; the result is the state shown (progress, done, the error line with Retry). No minimum
  // busy time: the next state replaces the button at once (Start -> progress with Cancel).
  const start = useAction(() => call('start'), { label: T.start, toast: 'never', minBusyMs: 0 })
  const cancel = useAction(() => call('cancel'), { label: T.cancel, toast: 'never', minBusyMs: 0 })
  const retry = useAction(() => call(unreachable ? 'status' : 'start'), { label: T.retry, toast: 'never', minBusyMs: 0 })
  const busy = start.busy || cancel.busy || retry.busy

  useEffect(() => { void call('status') }, []) // eslint-disable-line react-hooks/exhaustive-deps -- first read only
  useEffect(() => {
    if ((status?.state !== 'downloading' && status?.state !== 'retrying') || unreachable) return
    const t = setTimeout(() => void call('status'), DOWNLOAD_POLL_MS)
    return () => clearTimeout(t)
  }, [status, unreachable]) // eslint-disable-line react-hooks/exhaustive-deps -- `call` is stable in effect

  const error = unreachable ? T.unreachable : status?.state === 'failed' ? status.error : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 text-xs" data-chromium-download={status?.state ?? 'loading'} data-error-kind={status?.errorKind ?? undefined}>
      {status === null && !unreachable ? <p role="status" className="m-0 opacity-70">{T.checking}</p> : null}
      {status?.state === 'downloading' ? (
        <>
          <p role="status" className="m-0">{T.progress(status.percent)}</p>
          <div role="progressbar" aria-label={T.progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent}
            className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${status.percent}%` }} />
          </div>
          <ActionButton size="sm" variant="outline" className="self-start" disabled={busy} action={cancel} busyLabel={T.cancelling}>{T.cancel}</ActionButton>
        </>
      ) : null}
      {status?.state === 'retrying' && status.retry ? (
        <>
          <p role="status" className="m-0">{T.autoRetry(status.retry.attempt, status.retry.max)}</p>
          <ActionButton size="sm" variant="outline" className="self-start" disabled={busy} action={cancel} busyLabel={T.cancelling}>{T.cancel}</ActionButton>
        </>
      ) : null}
      {status?.state === 'done' ? (
        <p role="status" className="m-0 [overflow-wrap:anywhere]">{T.done} <code className="break-all">{status.executablePath}</code></p>
      ) : null}
      {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
      {status?.state === 'idle' && !unreachable ? (
        <>
          <ActionButton size="sm" variant="secondary" className="self-start" disabled={busy} action={start} busyLabel={T.starting}>{T.start}</ActionButton>
          <span className="opacity-70">{T.hint}</span>
        </>
      ) : null}
      {status?.state === 'failed' || unreachable ? (
        <ActionButton size="sm" variant="outline" className="self-start" disabled={busy} action={retry} busyLabel={T.retrying}>{T.retry}</ActionButton>
      ) : null}
    </div>
  )
}
