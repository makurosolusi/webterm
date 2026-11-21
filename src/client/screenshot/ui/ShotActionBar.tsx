// Horizontal action bar under the selection: copy, save, close. Nothing uploads or shares: the image stays in the browser.
import { Copy, Download, X } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { chordLabel } from '@/commandRegistry'
import { isMacPlatform } from '@/terminalKeys'
import { SHOT_TEXT } from './shot.ui.text'

export interface ShotActionBarProps {
  x: number
  y: number
  /** An export is running: both actions wait, close stays. */
  busy: 'copying' | 'saving' | null
  onCopy: () => void
  onSave: () => void
  onClose: () => void
}

export function ShotActionBar({ x, y, busy, onCopy, onSave, onClose }: ShotActionBarProps) {
  const key = (chord: string): string => chordLabel(chord, isMacPlatform())
  return (
    <div className="shot-bar shot-bar--actions" role="toolbar" aria-label={SHOT_TEXT.actions} aria-busy={busy !== null} style={{ left: x, top: y }}>
      <IconButton label={SHOT_TEXT.copy} shortcut={key('Mod+C')} side="bottom" className="shot-btn" disabled={busy !== null}
        disabledReason={busy ? SHOT_TEXT.busy[busy] : undefined} onClick={onCopy}>
        <Copy aria-hidden />
      </IconButton>
      <IconButton label={SHOT_TEXT.save} shortcut={key('Mod+S')} side="bottom" className="shot-btn" disabled={busy !== null}
        disabledReason={busy ? SHOT_TEXT.busy[busy] : undefined} onClick={onSave}>
        <Download aria-hidden />
      </IconButton>
      <IconButton label={SHOT_TEXT.close} shortcut="Esc" side="bottom" className="shot-btn" onClick={onClose}>
        <X aria-hidden />
      </IconButton>
    </div>
  )
}
