// Downloads control of a browser node's toolbar (right side, before the ⋮ menu, like Chrome): a Download icon with a count badge and a progress ring while files transfer;
// it opens the list. Nothing here asks for permission: a download just starts and lands in the webterm folder.
import { useId, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import type { DownloadItem } from '../../shared/browser.downloads'
import { BrowserDownloadsPopover } from './BrowserDownloadsPopover'
import { useBrowserDownloads } from './useBrowserDownloads'
import { DL_TEXT } from './browserDownloads.text'
import './browserDownloads.css'

const RING_R = 9
const RING_C = 2 * Math.PI * RING_R

export interface BrowserDownloadsProps {
  nodeId: string
  items: readonly DownloadItem[]
  /** false = the button is hidden (nothing downloaded yet; its width collapses), the list stays reachable via `open`. */
  showButton?: boolean
  /** Controlled open state (the ⋮ menu's Downloads row opens the same list); uncontrolled when absent. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export default function BrowserDownloads({ nodeId, items, showButton = true, open: openProp, onOpenChange }: BrowserDownloadsProps) {
  const { counts, speeds } = useBrowserDownloads(items)
  const [own, setOwn] = useState(false)
  const open = openProp ?? own
  const setOpen = (v: boolean) => { setOwn(v); onOpenChange?.(v) }
  const box = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popId = useId()
  const badge = counts.active + counts.waiting
  const label = counts.active > 0 ? DL_TEXT.buttonActive(counts.active) : counts.waiting > 0 ? DL_TEXT.buttonPending(counts.waiting) : DL_TEXT.button
  return (
    <span ref={box} className="bdl browser-toolbar__downloads nodrag inline-flex" data-browser-downloads data-shown={showButton ? 'true' : 'false'} data-active={counts.active > 0 ? 'true' : undefined}>
      {showButton && <IconButton
        ref={button} label={label} tooltip={badge > 0 ? label : DL_TEXT.tip} size="icon-bui" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Download aria-hidden="true" />
        {counts.active > 0 && (
          <svg className="bdl-ring" viewBox="0 0 24 24" aria-hidden="true" data-indeterminate={counts.fraction === null ? 'true' : undefined}>
            <circle className="bdl-ring-track" cx="12" cy="12" r={RING_R} />
            <circle className="bdl-ring-arc" cx="12" cy="12" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - (counts.fraction ?? 0.25))} />
          </svg>
        )}
        {badge > 0 && <span className="bdl-badge" aria-hidden="true">{badge > 9 ? '9+' : badge}</span>}
      </IconButton>}
      {open && (button.current ?? box.current) && <BrowserDownloadsPopover nodeId={nodeId} items={items} speeds={speeds} anchor={(button.current ?? box.current)!} id={popId} onClose={() => setOpen(false)} />}
    </span>
  )
}
