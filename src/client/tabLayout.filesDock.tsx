// Right-hand Files panel of tab mode (Orca's right-sidebar Explorer): holds the host of the first
// Files node. Closing only hides it (display:none) so the host never detaches and the tree keeps
// its scroll/expansion. The 4px handle on its left edge resizes it.
import { useCallback } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { FILES_PANEL_WIDTH } from '../shared/tabLayout.schema'
import { placeNodeHost } from './tabLayout.dom'
import { getTabLayout, setFilesPanelWidth, toggleFilesPanel } from './tabLayout.store'
import './tab-layout.css'

const KEY_STEP = 16

export interface FilesDockProps {
  /** Id of the Files node shown here, or null when the workspace has none. */
  filesId: string | null
  open: boolean
  width: number
  onAddFiles: () => void
}

export default function FilesDock({ filesId, open, width, onAddFiles }: FilesDockProps) {
  const slot = useCallback((el: HTMLDivElement | null) => { if (el && filesId) placeNodeHost(filesId, el) }, [filesId])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = getTabLayout().tabs.filesPanel.width
    e.currentTarget.setPointerCapture?.(e.pointerId)
    // The panel hugs the right edge, so dragging left widens it.
    const move = (ev: globalThis.PointerEvent) => setFilesPanelWidth(startW + startX - ev.clientX)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    setFilesPanelWidth(width + dir * KEY_STEP)
  }

  return (
    <aside className="tabs-files" aria-label="Files" style={{ width, display: open ? undefined : 'none' }}>
      <div
        className="tabs-files__handle" role="separator" aria-orientation="vertical" aria-label="Resize Files panel"
        aria-valuemin={FILES_PANEL_WIDTH.min} aria-valuemax={FILES_PANEL_WIDTH.max} aria-valuenow={width}
        tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown}
      />
      <header className="tabs-files__header">
        <span className="tabs-files__title">Files</span>
        <IconButton label="Close Files panel" side="bottom" size="icon-xs" onClick={toggleFilesPanel}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </IconButton>
      </header>
      {filesId ? (
        <div ref={slot} className="tabs-files__slot" data-tab-node="" data-id={filesId} />
      ) : (
        <div className="tabs-empty tabs-empty--panel">
          <p>No Files node in this workspace.</p>
          <Button size="sm" onClick={onAddFiles}>Open Files</Button>
        </div>
      )}
    </aside>
  )
}
