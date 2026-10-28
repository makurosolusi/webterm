import { ControlButton, Controls } from '@xyflow/react'
import { Lock, LockOpen, Maximize, Minus, Plus } from 'lucide-react'
import './canvas-ui.css'

// Rail zoom kiri-bawah. Memakai <Controls> React Flow untuk plat + posisinya, tapi glyph bawaan
// library dimatikan dan diganti ikon sendiri — persis seperti nodeterm `canvas/Canvas.tsx`:
// glyph bawaannya berbasis `fill`, sementara plat ini men-stroke ikon 15px (`fill: none`), jadi
// glyph bawaan akan tak terlihat di CSS ini.
//
// Lock di sini mengunci VIEW (pan/zoom) dan node tetap bisa digeser — semantik nodeterm, kebalikan
// dari `showInteractive` bawaan React Flow yang justru mematikan drag node. Karena itu tombolnya
// props-driven: pemanggil yang menyetel panOnDrag/panOnScroll/zoomOnScroll dari state yang sama.

export interface ZoomRailProps {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  locked: boolean
  onToggleLock: () => void
}

export default function ZoomRail({ onZoomIn, onZoomOut, onFit, locked, onToggleLock }: ZoomRailProps) {
  return (
    <Controls
      className="nopan nowheel"
      position="bottom-left"
      showZoom={false}
      showFitView={false}
      showInteractive={false}
    >
      <ControlButton aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>
        <Plus aria-hidden />
      </ControlButton>
      <ControlButton aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>
        <Minus aria-hidden />
      </ControlButton>
      <ControlButton aria-label="Fit view" title="Fit view" onClick={onFit}>
        <Maximize aria-hidden />
      </ControlButton>
      <ControlButton
        className={`canvas-lock-btn${locked ? ' locked' : ''}`}
        aria-label={locked ? 'Unlock view' : 'Lock view'}
        title={locked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom); nodes stay movable'}
        aria-pressed={locked}
        onClick={onToggleLock}
      >
        {locked ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
      </ControlButton>
    </Controls>
  )
}
