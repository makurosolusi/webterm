// The one `<video>` of a wallpaper layer: muted, looping, behind the pane, never clickable. It plays
// or pauses as `playing` says (`rewind` also shows the first frame again: playback Off) and reports
// the first loaded frame's luminance. Playback errors go to `onError` so the canvas falls back to the
// default look. Unmount drops the source so the decoder and its buffers are released.
import { useEffect, useRef } from 'react'
import { sampleLuminance } from './canvasBackground.sample'

interface Props {
  url: string
  fit: 'cover' | 'contain'
  playing: boolean
  rewind: boolean
  onLoaded: (luminance: number | null) => void
  onError: () => void
}

export function CanvasBackgroundVideo({ url, fit, playing, rewind, onLoaded, onError }: Props): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (playing) {
      // A pause() that interrupts play() rejects with AbortError: not a failure.
      v.play()?.catch((err: unknown) => { if ((err as Error)?.name !== 'AbortError') onErrorRef.current() })
    } else {
      v.pause()
      if (rewind) v.currentTime = 0
    }
  }, [playing, rewind])

  useEffect(() => {
    const v = ref.current // captured: React has cleared `ref` by the time the cleanup runs
    return () => {
      if (!v) return
      v.pause()
      v.src = ''
      v.load()
    }
  }, [])

  const loaded = (): void => {
    let luminance: number | null = null
    try {
      if (ref.current) luminance = sampleLuminance(ref.current)
    } catch (err) {
      // Sampling is a nicety (dot color, contrast hint); the wallpaper itself still plays.
      console.warn('canvas background: video luminance sample failed', err)
    }
    onLoaded(luminance)
  }

  return (
    <video
      ref={ref} src={url} data-testid="canvas-wallpaper-video"
      autoPlay muted loop playsInline disablePictureInPicture preload="auto"
      onLoadedData={loaded} onError={() => onErrorRef.current()}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, pointerEvents: 'none' }}
    />
  )
}
