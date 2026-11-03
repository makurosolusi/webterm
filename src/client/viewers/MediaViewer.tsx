export interface MediaViewerProps { src: string; kind: 'audio' | 'video'; name: string; onError: () => void }

/** Audio/video native dengan kontrol; `preload="metadata"` supaya file besar tidak diunduh utuh saat dibuka. */
export function MediaViewer({ src, kind, name, onError }: MediaViewerProps) {
  const Tag = kind
  return (
    <div className={`viewer viewer-${kind}`}>
      <Tag src={src} controls preload="metadata" aria-label={name} onError={onError} />
    </div>
  )
}
