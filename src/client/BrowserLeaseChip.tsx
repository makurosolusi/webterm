// "Agent is driving · Take control" chip (Take control = takeover). Mounted by BrowserNode.slots into
// `renderOverlay`. Always visible while driven, with no setting to hide it (nodeterm BrowserDrivingChip rule).
import { Button } from '@/components/ui/button'
import type { Lease } from '../shared/browser.contract'
import { CHIP_TEXT } from './browser.uxText'

/** Shown only while the agent holds the lease; `onTakeover` sends `takeover` to the server. */
export default function BrowserLeaseChip({ lease, onTakeover }: { lease?: Lease; onTakeover: () => void }) {
  if (lease !== 'agent') return null
  return (
    <div
      role="status"
      className="nodrag absolute top-2 right-2 z-10 flex items-center gap-2 rounded px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--browser-driven-tint,var(--vscode-editorWidget-border))"
    >
      <span>{CHIP_TEXT.driving} ·</span>
      <Button size="xs" variant="destructive" aria-label={CHIP_TEXT.stopLabel} onClick={onTakeover}>
        {CHIP_TEXT.stop}
      </Button>
    </div>
  )
}
