// What the overlay shows instead of the images when a capture failed: pane gone, tab asleep or crashed (no frame), or a
// read error. One block per failing side, each with its way out (Retry, or Wake for a tab without a picture).
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CaptureError } from './capture'

export interface CompareStatesProps {
  failures: { left?: CaptureError; right?: CaptureError }
  ids: { left: string; right: string }
  nameOf: (tabId: string) => string
  onWake: (tabId: string) => void
  onRetry: () => void
}

function message(f: CaptureError, name: string): string {
  if (f.kind === 'missing') return `The pane "${name}" is no longer on screen. Close this and pick the panes again.`
  if (f.kind === 'no-frame') return `"${name}" has no picture yet. The tab may be asleep or crashed.`
  return `Could not capture "${name}". ${f.message}`
}

export function CompareStates({ failures, ids, nameOf, onWake, onRetry }: CompareStatesProps) {
  const rows = ([['left', 'Base'], ['right', 'Compare']] as const).flatMap(([side, role]) => {
    const f = failures[side]
    return f ? [{ side, role, f, id: ids[side] }] : []
  })
  return (
    <div className="bc-states">
      {rows.map(({ side, role, f, id }) => (
        <section key={side} className="bc-state" role="alert" aria-label={`${role} capture failed`}>
          <TriangleAlert aria-hidden="true" />
          <p><strong>{role}:</strong> {message(f, nameOf(id))}</p>
          {f.kind === 'no-frame' && <Button size="bui" onClick={() => onWake(id)}>Wake</Button>}
          {f.kind !== 'missing' && <Button size="bui" variant="outline" onClick={onRetry}>Retry</Button>}
        </section>
      ))}
    </div>
  )
}
