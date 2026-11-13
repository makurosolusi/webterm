// Mounts the non-text viewer for a `fileKind` (used by EditorNode, WS-FM-02). The VIEWERS flag comes
// from `capabilities` (fail-closed): off = the safe placeholder; a failed check = an error with Retry.
import { useEffect, useState } from 'react'
import type { FileKind } from '../../shared/fileKind'
import type { FsCapabilities } from '../../shared/fsContract'
import { Button } from '../components/ui/button'
import { capabilities, rawUrl, stat } from '../fsClient'
import { BinaryPlaceholder } from './BinaryPlaceholder'
import { ImageViewer } from './ImageViewer'
import { MediaViewer } from './MediaViewer'
import { PdfViewer } from './PdfViewer'
import { pickViewer } from './viewerRegistry'
import './viewers.css'

/** What the viewer learned about the file, for the editor status bar. */
export interface ViewerMeta { width?: number; height?: number; bytes?: number }

export interface ViewerHostProps {
  path: string
  kind: FileKind
  /** Latest `FsVersion`; a change reloads the viewer (the URL changes too). */
  version?: string
  /** Called once per load failure; the host itself falls back to the placeholder. */
  onError?: (message: string) => void
  /** Reopen the file as text (SVG source, misdetected binaries). Absent = the action is hidden. */
  onOpenAsText?: () => void
  /** Dimensions (image/video) and size, each time more is known. */
  onMeta?: (meta: ViewerMeta) => void
}

const errName = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Viewer for a non-text file; `null` for text/markdown (they stay in the editor). */
export function ViewerHost({ path, kind, version, onError, onOpenAsText, onMeta }: ViewerHostProps) {
  const [caps, setCaps] = useState<FsCapabilities | null>(null)
  const [capsFailed, setCapsFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [bytes, setBytes] = useState<number | undefined>(undefined)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const needsViewer = pickViewer(kind, true) !== null

  useEffect(() => {
    if (!needsViewer) return
    let live = true
    setCapsFailed(false)
    capabilities().then(
      (c) => { if (live) setCaps(c) },
      (e: unknown) => {
        console.warn('viewer capabilities check failed', errName(e))
        if (live) setCapsFailed(true)
      },
    )
    return () => { live = false }
  }, [needsViewer, attempt])

  useEffect(() => {
    setFailed(false)
    setDims(null)
    setBytes(undefined)
    if (!needsViewer) return
    let live = true
    stat(path).then(
      (r) => { if (live && r.ok && r.meta.size !== undefined) setBytes(r.meta.size) },
      // Size is a nicety (status bar, placeholder); the viewer still works without it.
      (e: unknown) => console.warn('viewer stat failed', errName(e)),
    )
    return () => { live = false }
  }, [path, version, needsViewer, attempt])

  useEffect(() => {
    if (dims || bytes !== undefined) onMeta?.({ ...dims, bytes })
  }, [dims, bytes, onMeta])

  if (!needsViewer) return null
  const retry = (): void => { setFailed(false); setAttempt((n) => n + 1) }
  if (capsFailed)
    return (
      <div className="viewer viewer-placeholder" role="alert">
        <div className="viewer-meta">Couldn’t check which previews are available.</div>
        <div className="viewer-actions"><Button type="button" size="xs" className="viewer-btn" onClick={retry}>Retry</Button></div>
      </div>
    )
  if (!caps) return <div className="viewer viewer-placeholder" role="status">Loading…</div>

  const name = path.split('/').filter(Boolean).pop() ?? path
  const src = `${rawUrl(path)}${version ? `&v=${encodeURIComponent(version)}` : ''}`
  const fail = (): void => { setFailed(true); onError?.(`Could not load ${name}`) }
  const onDims = (width: number, height: number): void => setDims({ width, height })
  const id = failed ? 'placeholder' : pickViewer(kind, caps.viewers)
  const key = `${path}|${version ?? ''}|${attempt}`

  switch (id) {
    case 'image': return <ImageViewer key={key} src={src} name={name} onError={fail} onDims={onDims} onOpenAsText={onOpenAsText} />
    case 'media': return <MediaViewer key={key} src={src} kind={kind as 'audio' | 'video'} name={name} onError={fail} onDims={onDims} />
    case 'pdf': return <PdfViewer key={key} src={src} name={name} />
    default:
      return (
        <BinaryPlaceholder
          key={key}
          path={path}
          canDownload={caps.upload}
          size={bytes}
          note={failed ? 'Failed to load' : undefined}
          onRetry={failed ? retry : undefined}
          onOpenAsText={kind === 'archive' ? undefined : onOpenAsText}
        />
      )
  }
}
