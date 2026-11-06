import { useState } from 'react'
import { VscodeStatusBar } from '@/components/vscode/vscodeStatusBar'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { DockProps } from './Dock.types'
import { codicon } from './dockCodicon'
import { useShownBottomView } from './bottomPanelHost'
import { useTabLayout } from './tabLayout.store'

/** Preset zoom status bar, disalin dari nodeterm `src/renderer/lib/zoomPresets.ts`. */
export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const

/** Status bar items that toggle a bottom-panel view, by the view they show. */
const PANEL_VIEW_OF_ITEM: Record<string, string> = {
  problems: 'problems', activity: 'activity', 'output-errors': 'output', 'output-warnings': 'output',
}

/**
 * Status bar 22px: aksi kanvas (undo/redo/back/forward/fit/zoom) plus identitas workspace.
 * Readout zoom di sini membuka dialog preset — dialognya milik komponen ini supaya Dock tidak
 * perlu merender dua baris grid sekaligus.
 */
export function CanvasStatusBar(props: DockProps) {
  const [zoomOpen, setZoomOpen] = useState(false)
  // Tab mode has no canvas viewport, so these controls would do nothing.
  const canvasMode = useTabLayout().mode !== 'tabs'
  const shown = useShownBottomView()

  const left: VscodeStatusItem[] = []
  if (props.workspaceName) {
    left.push({ id: 'workspace', label: props.workspaceName, tooltip: 'Active workspace' })
  }

  const right: VscodeStatusItem[] = [
    ...(props.extraStatusItems ?? []).map((item) => (
      item.id in PANEL_VIEW_OF_ITEM ? { ...item, active: PANEL_VIEW_OF_ITEM[item.id] === shown } : item
    )),
    {
      id: 'undo', label: '', icon: codicon('discard'), tooltip: 'Undo last canvas change', ariaLabel: 'Undo',
      onClick: props.onUndo, disabled: !props.canUndo, disabledReason: 'nothing to undo',
    },
    {
      id: 'redo', label: '', icon: codicon('redo'), tooltip: 'Redo last undone change', ariaLabel: 'Redo',
      onClick: props.onRedo, disabled: !props.canRedo, disabledReason: 'nothing to redo',
    },
    ...(canvasMode ? [
    {
      id: 'back', label: '', icon: codicon('arrow-left'), tooltip: 'Go back to the previous view', ariaLabel: 'Go back',
      onClick: props.onBack, disabled: !props.canBack, disabledReason: 'no earlier view',
    },
    {
      id: 'forward', label: '', icon: codicon('arrow-right'), tooltip: 'Go forward to the next view', ariaLabel: 'Go forward',
      onClick: props.onForward, disabled: !props.canForward, disabledReason: 'no later view',
    },
    ] : []),
    ...(props.onSave ? [{
      id: 'save', label: '', icon: codicon('save'), tooltip: 'Save layout', ariaLabel: 'Save layout',
      onClick: props.onSave,
    }] : []),
    ...(props.onLayouts ? [{
      id: 'layouts', label: '', icon: codicon('layout'), tooltip: 'Layouts', ariaLabel: 'Layouts',
      onClick: props.onLayouts,
    }] : []),
    ...(props.onToggleMic ? [{
      id: 'mic', label: '', icon: codicon('mic'), tooltip: 'Dictate', ariaLabel: 'Dictate',
      onClick: props.onToggleMic,
    }] : []),
    ...(canvasMode ? [
    {
      id: 'fit', label: '', icon: codicon('screen-normal'), tooltip: 'Fit all nodes in view', ariaLabel: 'Fit view',
      commandId: 'view.fit', onClick: props.onFit,
    },
    {
      id: 'zoom-out', label: '', icon: codicon('zoom-out'), tooltip: 'Zoom out', ariaLabel: 'Zoom out',
      onClick: props.onZoomOut,
    },
    {
      id: 'zoom', label: `${props.zoomPct}%`, tooltip: `Zoom ${props.zoomPct}% — choose a preset`, ariaLabel: 'Zoom presets',
      onClick: props.onZoomTo ? () => setZoomOpen(true) : undefined,
    },
    {
      id: 'zoom-in', label: '', icon: codicon('zoom-in'), tooltip: 'Zoom in', ariaLabel: 'Zoom in',
      onClick: props.onZoomIn,
    },
    ] : []),
  ]

  return (
    <>
      <VscodeStatusBar
        className="app-statusbar"
        left={left}
        right={right}
        liveText={props.agentSummary}
      />
      {zoomOpen && canvasMode && (
        <Dialog open onOpenChange={setZoomOpen}>
          <DialogContent className="dock-zoom-dialog">
            <DialogHeader><DialogTitle>Zoom</DialogTitle></DialogHeader>
            <div className="dock-zoom-list">
              {ZOOM_PRESETS.map((p) => (
                <Button
                  key={p}
                  variant={p === props.zoomPct ? 'secondary' : 'ghost'}
                  className="dock-action-row"
                  onClick={() => { props.onZoomTo?.(p); setZoomOpen(false) }}
                >
                  <span className="dock-menu__check">{p === props.zoomPct && codicon('check')}</span>{p}%
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
