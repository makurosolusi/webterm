// Settings › Spending: what agents spent and the limits that pause work (CostPanel), plus a pointer to
// Central's own daily limit, which the Central Agent section owns (one key, one editor).
import { Button } from '@/components/ui/button'
import type { CentralLinkTarget } from './centralSettings.registry'
import { SPENDING_TEXT } from './controlPanelLabels'
import { CostPanel } from './CostPanel'

/** Spending section body; `onNavigate` opens another Settings section. */
export function SpendingSection({ onNavigate }: { onNavigate: (to: CentralLinkTarget) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="spending-section">
      <CostPanel />
      <p className="flex items-center gap-1">
        {SPENDING_TEXT.centralLimit} →
        <Button size="sm" variant="link" className="h-auto p-0" onClick={() => onNavigate({ section: 'central', field: 'central.costLimit' })}>{SPENDING_TEXT.centralLink}</Button>
      </p>
    </div>
  )
}
