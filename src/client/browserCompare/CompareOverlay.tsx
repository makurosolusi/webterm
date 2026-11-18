// Comparison overlay of two panes of one browser node: covers the node's page area, not the screen. Modes: swipe,
// onion skin, difference. Captures happen on open and on "Refresh capture" only; nothing polls.
import { useEffect, useReducer, useRef, useState } from 'react'
import { Copy, Download, Minus, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { COMPARE_MODES, compareReducer, initialCompare } from './compare.state'
import type { CompareMode } from './compare.state'
import { canCopyImage, copyPng, savePng } from './compare.export'
import type { ExportView } from './compare.export'
import { CompareSlider } from './CompareSlider'
import { CompareStates } from './CompareStates'
import { CompareView } from './CompareView'
import { MAX_THRESHOLD } from './diff'
import type { RunOptions } from './diff.run'
import { useComparison } from './useComparison'
import './compare.css'

export interface CompareOverlayProps {
  root: ParentNode | null
  ids: { left: string; right: string }
  /** Tab title per tab id, for labels and messages. */
  names: Record<string, string>
  onClose: () => void
  /** Wakes a sleeping or crashed tab; the user then refreshes the capture. */
  onWake: (tabId: string) => void
  run?: RunOptions
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

export function CompareOverlay({ root, ids, names, onClose, onWake, run }: CompareOverlayProps) {
  const [s, dispatch] = useReducer(compareReducer, initialCompare)
  const cmp = useComparison(root, ids, s.sizeMode, s.threshold, s.mode === 'diff', run)
  const [note, setNote] = useState('')
  const self = useRef<HTMLDivElement>(null)
  useEffect(() => { self.current?.focus() }, [])
  const nameOf = (id: string): string => names[id] ?? id
  const label = { a: nameOf(ids.left), b: nameOf(ids.right) }
  const differ = cmp.sizes && (cmp.sizes.a.w !== cmp.sizes.b.w || cmp.sizes.a.h !== cmp.sizes.b.h)
  const pct = cmp.diff.kind === 'done' ? `${cmp.diff.result.percent}% of pixels differ` : ''
  const view: ExportView | null = cmp.pair && (s.mode !== 'diff' || cmp.diff.kind === 'done')
    ? { mode: s.mode, swipe: s.swipe, onion: s.onion, a: cmp.pair.a, b: cmp.pair.b, diff: cmp.diff.kind === 'done' ? cmp.diff.result.image : undefined }
    : null
  const save = (): void => { if (view) void savePng(view, new Date()).then((r) => setNote(r.ok ? 'Comparison saved as PNG' : r.message)) }
  const copy = (): void => { if (view) void copyPng(view).then((r) => setNote(r.ok ? 'Comparison copied' : r.message)) }

  return (
    <div
      ref={self} className="bc-overlay nodrag nopan nowheel nokey" role="dialog" aria-label="Compare panes" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div className="bc-bar">
        <Tabs value={s.mode} onValueChange={(v) => dispatch({ type: 'mode', mode: v as CompareMode })}>
          <TabsList aria-label="Comparison mode">{COMPARE_MODES.map((m) => <TabsTrigger key={m.id} value={m.id}>{m.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <span className="bc-spacer" />
        <IconButton label="Refresh capture" size="icon-bui" onClick={cmp.refresh}><RefreshCw aria-hidden="true" /></IconButton>
        <IconButton label="Close comparison" size="icon-bui" onClick={onClose}><X aria-hidden="true" /></IconButton>
      </div>
      <div className="bc-opts">
        {s.mode === 'onion' && (
          <span className="bc-field">Opacity of Compare
            <span className="bc-track"><CompareSlider value={s.onion} onChange={(v) => dispatch({ type: 'onion', value: v })} label="Compare opacity" valueText={`${s.onion}%`} className="bc-thumb" /></span>
            <output>{s.onion}%</output>
          </span>
        )}
        {s.mode === 'diff' && (
          <>
            <span className="bc-field" role="group" aria-label="Tolerance">Tolerance
              <IconButton label="Lower tolerance" size="icon-bui" disabled={s.threshold <= 0} onClick={() => dispatch({ type: 'threshold', value: s.threshold - 1 })}><Minus aria-hidden="true" /></IconButton>
              <output aria-label="Tolerance value">{s.threshold}</output>
              <IconButton label="Raise tolerance" size="icon-bui" disabled={s.threshold >= MAX_THRESHOLD} onClick={() => dispatch({ type: 'threshold', value: s.threshold + 1 })}><Plus aria-hidden="true" /></IconButton>
            </span>
            <span className="bc-legend"><i className="bc-swatch" aria-hidden="true" /> Differs <i className="bc-swatch bc-swatch--same" aria-hidden="true" /> Same</span>
          </>
        )}
        {differ && <Button size="bui" variant={s.sizeMode === 'actual' ? 'secondary' : 'outline'} aria-pressed={s.sizeMode === 'actual'} onClick={() => dispatch({ type: 'size', sizeMode: s.sizeMode === 'actual' ? 'fit' : 'actual' })}>Compare at actual size</Button>}
      </div>
      {differ && cmp.sizes && s.sizeMode === 'fit' && (
        <p className="bc-warn" role="status">Sizes differ ({cmp.sizes.a.w} x {cmp.sizes.a.h} vs {cmp.sizes.b.w} x {cmp.sizes.b.h}); scaled to fit</p>
      )}
      <div className="bc-body">
        {cmp.status === 'loading' && <div className="bc-skeleton" role="status" aria-label="Capturing panes" />}
        {cmp.status === 'ready' && !cmp.pair && <CompareStates failures={cmp.failures} ids={ids} nameOf={nameOf} onWake={onWake} onRetry={cmp.refresh} />}
        {cmp.pair && <CompareView state={s} pair={cmp.pair} diff={cmp.diff} names={label} onSwipe={(v) => dispatch({ type: 'swipe', value: v })} onCancel={cmp.cancelDiff} onRecompute={cmp.recompute} />}
      </div>
      <div className="bc-foot">
        {cmp.capturedAt && <span>Captured {clock(cmp.capturedAt)}</span>}
        <span className="bc-pct" aria-live="polite">{pct}</span>
        <span className="bc-spacer" />
        <span className="bc-note" role="status">{note}</span>
        <Button size="bui" variant="outline" disabled={!view} onClick={save}><Download aria-hidden="true" /> Save comparison as PNG</Button>
        {canCopyImage() && <Button size="bui" variant="outline" disabled={!view} onClick={copy}><Copy aria-hidden="true" /> Copy</Button>}
      </div>
    </div>
  )
}
