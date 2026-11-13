export interface MediaViewerProps {
  src: string
  kind: 'audio' | 'video'
  name: string
  onError: () => void
  /** Video frame size, once its metadata has loaded. */
  onDims?: (width: number, height: number) => void
}

/**
 * Native audio/video with controls; `preload="metadata"` so a big file is not downloaded whole on
 * open. `nodrag`: scrubbing the timeline must not move the node.
 */
export function MediaViewer({ src, kind, name, onError, onDims }: MediaViewerProps) {
  const Tag = kind
  return (
    <div className={`viewer viewer-${kind} nodrag`}>
      <Tag
        src={src}
        controls
        preload="metadata"
        aria-label={name}
        onError={onError}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget as HTMLVideoElement
          if (kind === 'video' && v.videoWidth) onDims?.(v.videoWidth, v.videoHeight)
        }}
      />
    </div>
  )
}
