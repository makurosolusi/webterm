// One download in the node's list: file icon, name, source host, progress (speed, time left), and its actions.
// Every action runs through useAction (busy state, a visible failure, a short success line): nothing is fire-and-forget.
import { Ban, Copy, File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, Save, Trash2, TriangleAlert } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { ActionButton, useAction } from '@/components/ui/action'
import type { Action } from '@/components/ui/action'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { downloadFraction } from '../../shared/browser.downloads'
import type { DownloadItem } from '../../shared/browser.downloads'
import { writeClipboard } from '../browser.clipboard'
import { cancelDownload, downloadPath, keepDownload, removeDownload, saveCopy } from './browserDownloads.api'
import { DL_TEXT, failureText, formatEta, formatSpeed, sizeLine } from './browserDownloads.text'
import { etaSeconds, fileKind, rowStatus } from './browserDownloads.state'
import type { FileKind } from './browserDownloads.state'

const ICONS: Record<FileKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  image: FileImage, audio: FileAudio, video: FileVideo, archive: FileArchive, code: FileCode, text: FileText, file: File,
}

/** Click handler that starts an action (its busy state and result are shown by the row). */
const start = (a: Action<unknown>) => (): void => { void a.run() }

export interface BrowserDownloadRowProps { nodeId: string; item: DownloadItem; bps: number }

export function BrowserDownloadRow({ nodeId, item, bps }: BrowserDownloadRowProps) {
  const status = rowStatus(item)
  const cancel = useAction(() => cancelDownload(nodeId, item.id), { label: DL_TEXT.cancel, minBusyMs: 0, success: () => DL_TEXT.canceled })
  const remove = useAction(() => removeDownload(nodeId, item.id), { label: DL_TEXT.remove, minBusyMs: 0 })
  const keep = useAction(() => keepDownload(nodeId, item.id), { label: DL_TEXT.keep, minBusyMs: 0 })
  const copy = useAction(async () => {
    const r = await writeClipboard(await downloadPath(nodeId, item.id))
    if (!r.ok) throw new Error(r.error)
  }, { label: DL_TEXT.copyPath, minBusyMs: 0, success: () => DL_TEXT.copied, failure: () => DL_TEXT.copyFailed })
  const save = useAction(() => Promise.resolve(saveCopy(nodeId, item.id, item.name)), { label: DL_TEXT.saveCopy, minBusyMs: 0, success: () => DL_TEXT.saveStarted })
  const last = [cancel, remove, keep, copy, save].filter((a) => a.result).sort((a, b) => (b.result?.at ?? 0) - (a.result?.at ?? 0))[0]
  const Icon = ICONS[fileKind(item.name)]
  const fraction = downloadFraction(item)
  const pct = fraction === null ? undefined : Math.round(fraction * 100)
  const eta = status === 'running' ? etaSeconds(item, bps) : null
  const meta = [item.host, status === 'failed' || status === 'canceled' ? undefined : sizeLine(item), status === 'running' && bps > 0 ? formatSpeed(bps) : undefined, eta !== null ? formatEta(eta) : undefined]
    .filter((x): x is string => Boolean(x)).join(' · ')
  const busy = cancel.busy || remove.busy || keep.busy

  return (
    <li className="bdl-row" data-download={item.id} data-status={status} data-risky={item.risky ? 'true' : undefined} aria-busy={busy}>
      <Icon className="bdl-kind" aria-hidden="true" />
      <div className="bdl-main">
        <div className="bdl-name">
          <span className="bdl-filename">{item.name}</span>
          {item.risky && (
            <IconTooltip label={DL_TEXT.risky}>
              <span className="bdl-risky" role="img" aria-label={DL_TEXT.risky} tabIndex={0}><TriangleAlert aria-hidden="true" /></span>
            </IconTooltip>
          )}
        </div>
        <div className="bdl-meta">{meta}</div>
        {status === 'running' && (
          <div
            className="bdl-bar" role="progressbar" aria-label={`${item.name} download progress`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={pct} aria-valuetext={pct === undefined ? DL_TEXT.sizeUnknown : `${pct}%`} data-indeterminate={pct === undefined ? 'true' : undefined}
          >
            <div className="bdl-fill" style={pct === undefined ? undefined : { width: `${pct}%` }} />
          </div>
        )}
        {status === 'failed' && <div className="bdl-state bdl-state--bad" role="status">{`${DL_TEXT.failedPrefix}: ${failureText(item.failure)}`}</div>}
        {status === 'canceled' && <div className="bdl-state" role="status">{DL_TEXT.canceled}</div>}
        {status === 'missing' && <div className="bdl-state bdl-state--bad" role="status">{DL_TEXT.missing}</div>}
        {item.pending && status === 'done' && (
          <div className="bdl-ask" role="group" aria-label={DL_TEXT.askQuestion}>
            <span>{DL_TEXT.askQuestion}</span>
            <ActionButton action={keep} busyLabel="Keeping" size="bui">{DL_TEXT.keep}</ActionButton>
            <ActionButton action={remove} busyLabel="Discarding" size="bui" variant="ghost">{DL_TEXT.discard}</ActionButton>
          </div>
        )}
        {last?.result && !(last === keep && last.result.ok) && (
          <div className={last.result.ok ? 'bdl-state' : 'bdl-state bdl-state--bad'} role={last.result.ok ? 'status' : 'alert'}>{last.result.text}</div>
        )}
      </div>
      <div className="bdl-actions">
        {status === 'running' && <IconButton label={DL_TEXT.cancel} size="icon-bui" disabled={cancel.busy} onClick={start(cancel)}><Ban aria-hidden="true" /></IconButton>}
        {status === 'done' && !item.pending && <IconButton label={DL_TEXT.saveCopy} size="icon-bui" disabled={save.busy} onClick={start(save)}><Save aria-hidden="true" /></IconButton>}
        {status === 'done' && <IconButton label={DL_TEXT.copyPath} size="icon-bui" disabled={copy.busy} onClick={start(copy)}><Copy aria-hidden="true" /></IconButton>}
        {status !== 'running' && !item.pending && <IconButton label={DL_TEXT.remove} size="icon-bui" disabled={remove.busy} onClick={start(remove)}><Trash2 aria-hidden="true" /></IconButton>}      </div>
    </li>
  )
}
