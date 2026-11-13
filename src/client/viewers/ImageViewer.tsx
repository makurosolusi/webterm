import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { Button } from '../components/ui/button'
import { IconButton } from '../components/ui/icon-button'
import { fitScale, stepZoom, wheelZoom, zoomLabel } from './imageZoom'

export interface ImageViewerProps {
  src: string
  name: string
  onError: () => void
  /** Natural size, once the image has decoded. */
  onDims?: (width: number, height: number) => void
  /** Shown for SVG: reopen the file in the text editor. */
  onOpenAsText?: () => void
}

type Anchor = { px: number; py: number; ix: number; iy: number }

/**
 * Image (including SVG) through `<img>`: an SVG here cannot run scripts, unlike iframe/object.
 * VS Code image preview behaviour: fit by default, ⌘/Ctrl+wheel or pinch zooms around the cursor,
 * plain wheel and drag pan once zoomed, keys 0 = fit, 1 = 100%, +/− step; checkerboard behind
 * transparency. `nowheel nodrag` keep the canvas from zooming or moving the node meanwhile.
 */
export function ImageViewer({ src, name, onError, onDims, onOpenAsText }: ImageViewerProps) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null) // null = fit
  const anchor = useRef<Anchor | null>(null)
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  const scaleNow = (): number => {
    if (zoom !== null) return zoom
    const b = box.current
    return nat && b ? fitScale(nat, { w: b.clientWidth, h: b.clientHeight }) : 1
  }
  /** Zoom to `next`, keeping the image point under (clientX, clientY) (default: centre) in place. */
  const zoomTo = (next: number | null, clientX?: number, clientY?: number): void => {
    const b = box.current
    const el = img.current
    if (b && el && next !== null) {
      const r = b.getBoundingClientRect()
      const px = clientX === undefined ? b.clientWidth / 2 : clientX - r.left
      const py = clientY === undefined ? b.clientHeight / 2 : clientY - r.top
      const s = scaleNow()
      anchor.current = { px, py, ix: (b.scrollLeft + px - el.offsetLeft) / s, iy: (b.scrollTop + py - el.offsetTop) / s }
    }
    setZoom(next)
  }
  const zoomRef = useRef(zoomTo)
  zoomRef.current = zoomTo

  useLayoutEffect(() => {
    const a = anchor.current
    const b = box.current
    const el = img.current
    anchor.current = null
    if (!a || !b || !el || zoom === null) return
    b.scrollLeft = el.offsetLeft + a.ix * zoom - a.px
    b.scrollTop = el.offsetTop + a.iy * zoom - a.py
  }, [zoom])

  // Native listener: React's wheel listener is passive, and Ctrl+wheel must not zoom the page.
  useEffect(() => {
    const b = box.current
    if (!b) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return // plain wheel scrolls (pans) the box natively
      e.preventDefault()
      const z = zoomRef.current
      z(wheelZoom(scaleOf(), e.deltaY), e.clientX, e.clientY)
    }
    const scaleOf = (): number => {
      const el = img.current
      return el && el.naturalWidth ? el.clientWidth / el.naturalWidth : 1
    }
    b.addEventListener('wheel', onWheel, { passive: false })
    return () => b.removeEventListener('wheel', onWheel)
  }, [])

  const onKey = (e: KeyboardEvent): void => {
    const act: Record<string, () => void> = {
      '0': () => zoomTo(null), '1': () => zoomTo(1),
      '+': () => zoomTo(stepZoom(scaleNow(), 1)), '=': () => zoomTo(stepZoom(scaleNow(), 1)),
      '-': () => zoomTo(stepZoom(scaleNow(), -1)),
    }
    const run = act[e.key]
    if (!run || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    run()
  }
  const onPointerDown = (e: PointerEvent): void => {
    const b = box.current
    if (zoom === null || !b || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, sl: b.scrollLeft, st: b.scrollTop }
    b.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent): void => {
    const d = drag.current
    const b = box.current
    if (!d || !b) return
    b.scrollLeft = d.sl - (e.clientX - d.x)
    b.scrollTop = d.st - (e.clientY - d.y)
  }
  const endDrag = (): void => { drag.current = null }

  const style: CSSProperties | undefined = zoom !== null && nat
    ? { width: nat.w * zoom, height: nat.h * zoom, maxWidth: 'none', maxHeight: 'none', imageRendering: zoom > 1 ? 'pixelated' : undefined }
    : undefined
  const isSvg = /\.svg$/i.test(name)

  return (
    <div className="viewer-image-wrap">
      <div
        ref={box}
        className={`viewer viewer-image nowheel nodrag${zoom !== null ? ' viewer-image--zoomed' : ''}`}
        tabIndex={0}
        role="group"
        aria-label={`Image ${name}`}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {!nat && <span className="viewer-loading" role="status">Loading…</span>}
        <img
          ref={img}
          src={src}
          alt={name}
          draggable={false}
          style={style}
          onError={onError}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget
            setNat({ w, h })
            onDims?.(w, h)
          }}
        />
      </div>
      <div className="viewer-zoombar nodrag" role="toolbar" aria-label="Zoom">
        <IconButton size="icon-xs" label="Zoom Out" shortcut="-" disabled={!nat} onClick={() => zoomTo(stepZoom(scaleNow(), -1))}>
          <span className="codicon codicon-zoom-out" aria-hidden="true" />
        </IconButton>
        <span className="viewer-zoombar__level" aria-live="polite">{nat ? `${zoom === null ? 'Fit · ' : ''}${zoomLabel(scaleNow())}` : '—'}</span>
        <IconButton size="icon-xs" label="Zoom In" shortcut="+" disabled={!nat} onClick={() => zoomTo(stepZoom(scaleNow(), 1))}>
          <span className="codicon codicon-zoom-in" aria-hidden="true" />
        </IconButton>
        <Button type="button" size="xs" variant="ghost" aria-pressed={zoom === null} disabled={!nat} onClick={() => zoomTo(null)}>Fit</Button>
        <Button type="button" size="xs" variant="ghost" aria-pressed={zoom === 1} disabled={!nat} onClick={() => zoomTo(1)}>100%</Button>
        {isSvg && onOpenAsText && <Button type="button" size="xs" variant="ghost" onClick={onOpenAsText}>Open as Text</Button>}
      </div>
    </div>
  )
}
