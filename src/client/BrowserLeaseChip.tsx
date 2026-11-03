// Chip "agent mengemudi" + tombol Stop (= ambil alih). Ditempel WS-11 ke slot `renderOverlay`.
import { Button } from '@/components/ui/button'
import type { Lease } from '../shared/browser.contract'
import { CHIP_TEXT } from './browser.uxText'

/** Tampil hanya saat lease di tangan agent; `onTakeover` mengirim `takeover` ke server. */
export default function BrowserLeaseChip({ lease, onTakeover }: { lease?: Lease; onTakeover: () => void }) {
  if (lease !== 'agent') return null
  return (
    <div
      role="status"
      className="nodrag absolute top-2 right-2 z-10 flex items-center gap-2 rounded px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)"
    >
      <span>{CHIP_TEXT.driving}</span>
      <Button size="xs" variant="destructive" aria-label={CHIP_TEXT.stopLabel} onClick={onTakeover}>
        {CHIP_TEXT.stop}
      </Button>
    </div>
  )
}
