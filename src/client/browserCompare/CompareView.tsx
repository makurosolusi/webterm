// The stage of the overlay: the two captures layered for the chosen mode (swipe divider, onion-skin blend, difference map).
import type { CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import type { CompareState } from './compare.state'
import { CompareSlider } from './CompareSlider'
import type { Pixels } from './diff'
import { PixelCanvas } from './PixelCanvas'
import type { DiffState } from './useComparison'

export interface CompareViewProps {
  state: CompareState
  pair: { a: Pixels; b: Pixels }
  diff: DiffState
  names: { a: string; b: string }
  onSwipe: (v: number) => void
  onCancel: () => void
  onRecompute: () => void
}

export function CompareView({ state, pair, diff, names, onSwipe, onCancel, onRecompute }: CompareViewProps) {
  const { a, b } = pair
  const base = `Base: ${names.a}`, other = `Compare: ${names.b}`
  return (
    <div className="bc-stage" style={{ '--bc-ratio': String(a.width / a.height) } as CSSProperties} data-mode={state.mode}>
      {state.mode === 'swipe' && (
        <>
          <PixelCanvas pixels={b} className="bc-layer" label={other} />
          <div className="bc-clip" style={{ clipPath: `inset(0 ${100 - state.swipe}% 0 0)` }}><PixelCanvas pixels={a} className="bc-layer" label={base} /></div>
          <CompareSlider value={state.swipe} onChange={onSwipe} label="Swipe position" valueText={`${state.swipe}% Base, ${100 - state.swipe}% Compare`} className="bc-divider">
            <span className="bc-grip" aria-hidden="true" />
          </CompareSlider>
        </>
      )}
      {state.mode === 'onion' && (
        <>
          <PixelCanvas pixels={a} className="bc-layer" label={base} />
          <PixelCanvas pixels={b} className="bc-layer" label={other} style={{ opacity: state.onion / 100 }} />
        </>
      )}
      {state.mode === 'diff' && (
        <>
          <PixelCanvas pixels={a} className="bc-layer bc-layer--dim" label={base} />
          {diff.kind === 'done' && <PixelCanvas pixels={diff.result.image} className="bc-layer" label="Pixels that differ, in red" />}
          {diff.kind === 'computing' && (
            <div className="bc-busy" role="status"><span>Computing...</span><Button size="bui" variant="outline" onClick={onCancel}>Cancel</Button></div>
          )}
          {diff.kind === 'cancelled' && <div className="bc-busy" role="status"><span>Comparison cancelled</span><Button size="bui" onClick={onRecompute}>Compute</Button></div>}
          {diff.kind === 'error' && <div className="bc-busy" role="alert"><span>{diff.message}</span><Button size="bui" onClick={onRecompute}>Retry</Button></div>}
        </>
      )}
    </div>
  )
}
