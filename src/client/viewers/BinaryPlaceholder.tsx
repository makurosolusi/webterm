import { useEffect, useState } from 'react'
import { formatBytes } from '../../shared/fsLimits'
import { Button } from '../components/ui/button'
import { writeClipboard } from '../clipboard'
import { rawUrl } from '../fsClient'

export interface BinaryPlaceholderProps {
  path: string
  /** Download is offered only when UPLOAD is on (the transfer endpoint is open). */
  canDownload: boolean
  /** File size in bytes, once known (ViewerHost stats the file). */
  size?: number
  /** Why this is a placeholder, e.g. the viewer failed to load. */
  note?: string
  /** Shown with `note`: load the viewer again. */
  onRetry?: () => void
  /** Reopen the file in the text editor (VS Code "Open Anyway"): misdetected text, SVG source. */
  onOpenAsText?: () => void
}

const COPIED_MS = 1500

/** Card for a file that cannot be shown: name, size, Retry (after a failure), Open as Text, Download (UPLOAD on), Copy Path. */
export function BinaryPlaceholder({ path, canDownload, size, note, onRetry, onOpenAsText }: BinaryPlaceholderProps) {
  const name = path.split('/').filter(Boolean).pop() ?? path
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="viewer viewer-placeholder" role={note ? 'alert' : 'note'}>
      <div className="viewer-name">{name}</div>
      <div className="viewer-meta">{size === undefined ? 'Preview not available' : `${formatBytes(size)} · Preview not available`}</div>
      {note ? <div className="viewer-meta">{note}</div> : null}
      <div className="viewer-actions">
        {note && onRetry ? <Button type="button" size="xs" className="viewer-btn" onClick={onRetry}>Retry</Button> : null}
        {onOpenAsText ? <Button type="button" size="xs" className="viewer-btn" onClick={onOpenAsText}>Open as Text</Button> : null}
        {canDownload ? <a className="viewer-btn" href={`${rawUrl(path)}&download=1`} download={name}>Download</a> : null}
        <Button type="button" size="xs" className="viewer-btn" onClick={() => void writeClipboard(path).then(setCopied)}>
          {copied ? 'Copied' : 'Copy Path'}
        </Button>
      </div>
    </div>
  )
}
