import { useEffect, useState } from 'react'
import { formatBytes } from '../../shared/fsLimits'
import { writeClipboard } from '../clipboard'
import { rawUrl, stat } from '../fsClient'

export interface BinaryPlaceholderProps {
  path: string
  /** Download hanya ditawarkan bila UPLOAD aktif (endpoint transfer terbuka). */
  canDownload: boolean
  /** Alasan tampil sebagai placeholder, mis. gagal dimuat. */
  note?: string
}

const COPIED_MS = 1500

/** Kartu file yang tak bisa ditampilkan: nama, ukuran, Download (bila UPLOAD aktif), Copy Path. */
export function BinaryPlaceholder({ path, canDownload, note }: BinaryPlaceholderProps) {
  const name = path.split('/').filter(Boolean).pop() ?? path
  const [size, setSize] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void stat(path).then((r) => { if (live && r.ok && r.meta.size !== undefined) setSize(r.meta.size) })
    return () => { live = false }
  }, [path])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="viewer viewer-placeholder" role="note">
      <div className="viewer-name">{name}</div>
      <div className="viewer-meta">{size === null ? 'Preview not available' : `${formatBytes(size)} · Preview not available`}</div>
      {note ? <div className="viewer-meta">{note}</div> : null}
      <div className="viewer-actions">
        {canDownload ? <a className="viewer-btn" href={`${rawUrl(path)}&download=1`} download={name}>Download</a> : null}
        <button type="button" className="viewer-btn" onClick={() => void writeClipboard(path).then(setCopied)}>
          {copied ? 'Copied' : 'Copy Path'}
        </button>
      </div>
    </div>
  )
}
