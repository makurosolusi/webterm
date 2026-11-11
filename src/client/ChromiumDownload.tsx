// "Download Chromium" control shared by the wizard Browser step and Settings › Capabilities › Advanced:
// start, progress (polled while the server downloads), cancel, failed + Retry, done. The server saves
// the downloaded binary as the browser to use; `onDone` reloads the capabilities so the UI follows.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ChromiumDownloadStatus } from '../shared/featureCapabilities'
import { DOWNLOAD_TEXT as T } from './advancedLabels'
import { chromiumDownload } from './capabilitiesApi'

/** Progress refresh while downloading; the server only keeps a counter, so polling is cheap. */
export const DOWNLOAD_POLL_MS = 500

export interface ChromiumDownloadProps {
  /** Called once a download this view watched finishes (reload capabilities). */
  onDone(): Promise<void> | void
  /** Every status the view shows (the wizard enables Continue on `done`). */
  onStatus?(status: ChromiumDownloadStatus): void
}

/** The download control with all its states; reads the server status on mount (a download may already run). */
export function ChromiumDownload({ onDone, onStatus }: ChromiumDownloadProps): React.JSX.Element {
  const [status, setStatus] = useState<ChromiumDownloadStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const cb = useRef({ onDone, onStatus })
  cb.current = { onDone, onStatus }
  const prev = useRef<ChromiumDownloadStatus['state'] | null>(null)

  const show = (s: ChromiumDownloadStatus): void => {
    if (prev.current === 'downloading' && s.state === 'done') void cb.current.onDone()
    prev.current = s.state
    setStatus(s)
    setUnreachable(false)
    cb.current.onStatus?.(s)
  }
  const call = async (action: 'status' | 'start' | 'cancel'): Promise<void> => {
    setBusy(action !== 'status')
    try {
      show(await chromiumDownload(action))
    } catch (e) {
      console.warn('chromium download: request failed', action, e instanceof Error ? e.message : 'error')
      setUnreachable(true)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void call('status') }, []) // eslint-disable-line react-hooks/exhaustive-deps -- first read only
  useEffect(() => {
    if (status?.state !== 'downloading' || unreachable) return
    const t = setTimeout(() => void call('status'), DOWNLOAD_POLL_MS)
    return () => clearTimeout(t)
  }, [status, unreachable]) // eslint-disable-line react-hooks/exhaustive-deps -- `call` is stable in effect

  const error = unreachable ? T.unreachable : status?.state === 'failed' ? status.error : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 text-xs" data-chromium-download={status?.state ?? 'loading'}>
      {status === null && !unreachable ? <p role="status" className="m-0 opacity-70">{T.checking}</p> : null}
      {status?.state === 'downloading' ? (
        <>
          <p role="status" className="m-0">{T.progress(status.percent)}</p>
          <div role="progressbar" aria-label={T.progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent}
            className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${status.percent}%` }} />
          </div>
          <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void call('cancel')}>{T.cancel}</Button>
        </>
      ) : null}
      {status?.state === 'done' ? (
        <p role="status" className="m-0 [overflow-wrap:anywhere]">{T.done} <code className="break-all">{status.executablePath}</code></p>
      ) : null}
      {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
      {status?.state === 'idle' && !unreachable ? (
        <>
          <Button size="sm" variant="secondary" className="self-start" disabled={busy} onClick={() => void call('start')}>{T.start}</Button>
          <span className="opacity-70">{T.hint}</span>
        </>
      ) : null}
      {status?.state === 'failed' || unreachable ? (
        <Button size="sm" variant="outline" className="self-start" disabled={busy}
          onClick={() => void call(unreachable ? 'status' : 'start')}>{T.retry}</Button>
      ) : null}
    </div>
  )
}
