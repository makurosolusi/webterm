// Paints a Pixels buffer on a <canvas>; sized by CSS (the buffer keeps its own resolution).
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { Pixels } from './diff'

export function PixelCanvas({ pixels, className, label, style }: { pixels: Pixels; className?: string; label?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current, ctx = c?.getContext('2d')
    if (!c || !ctx) return // no 2D canvas (jsdom): nothing to paint
    const img = ctx.createImageData(pixels.width, pixels.height)
    img.data.set(pixels.data)
    ctx.putImageData(img, 0, 0)
  }, [pixels])
  return <canvas ref={ref} className={className} style={style} width={pixels.width} height={pixels.height} role="img" aria-label={label} />
}
