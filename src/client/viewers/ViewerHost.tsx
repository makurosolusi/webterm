// Pemasang viewer non-teks per `fileKind` (dipakai EditorNode, WS-FM-02). Flag VIEWERS dibaca dari
// `capabilities` (fail-closed): mati/gagal = placeholder aman, bukan menebak hidup.
import { useEffect, useState } from 'react'
import type { FileKind } from '../../shared/fileKind'
import type { FsCapabilities } from '../../shared/fsContract'
import { capabilities, rawUrl } from '../fsClient'
import { BinaryPlaceholder } from './BinaryPlaceholder'
import { ImageViewer } from './ImageViewer'
import { MediaViewer } from './MediaViewer'
import { PdfViewer } from './PdfViewer'
import { pickViewer } from './viewerRegistry'
import './viewers.css'

export interface ViewerHostProps {
  path: string
  kind: FileKind
  /** `FsVersion` terbaru; berubah = viewer dimuat ulang (URL ikut berubah). */
  version?: string
  /** Dipanggil sekali per kegagalan muat; host sendiri jatuh ke placeholder. */
  onError?: (message: string) => void
}

/** Viewer untuk file non-teks; `null` untuk text/markdown (tetap di editor). */
export function ViewerHost({ path, kind, version, onError }: ViewerHostProps) {
  const [caps, setCaps] = useState<FsCapabilities | null>(null)
  const [failed, setFailed] = useState(false)
  const needsViewer = pickViewer(kind, true) !== null

  useEffect(() => {
    if (!needsViewer) return
    let live = true
    void capabilities().then((c) => { if (live) setCaps(c) })
    return () => { live = false }
  }, [needsViewer])
  useEffect(() => setFailed(false), [path, version])

  if (!needsViewer) return null
  if (!caps) return <div className="viewer viewer-placeholder" role="status">Loading…</div>

  const name = path.split('/').filter(Boolean).pop() ?? path
  const src = `${rawUrl(path)}${version ? `&v=${encodeURIComponent(version)}` : ''}`
  const fail = (): void => { setFailed(true); onError?.(`Could not load ${name}`) }
  const id = failed ? 'placeholder' : pickViewer(kind, caps.viewers)
  const key = `${path}|${version ?? ''}`

  switch (id) {
    case 'image': return <ImageViewer key={key} src={src} name={name} onError={fail} />
    case 'media': return <MediaViewer key={key} src={src} kind={kind as 'audio' | 'video'} name={name} onError={fail} />
    case 'pdf': return <PdfViewer key={key} src={src} name={name} />
    default: return <BinaryPlaceholder key={key} path={path} canDownload={caps.upload} note={failed ? 'Failed to load' : undefined} />
  }
}
