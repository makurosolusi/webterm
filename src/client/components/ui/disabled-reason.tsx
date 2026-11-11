// Why a control is disabled, under it: lock icon + reason + an optional button to the setting that
// controls it. The control's own description stays visible above; this line never replaces it.
import { Button } from '@/components/ui/button'

/** A control is locked by another setting: `reason` says why, `fix` jumps to (or flips) that setting. */
export interface Lock {
  reason: string
  fix?: { label: string; run(): void }
}

/** The reason line; point the control's `aria-describedby` at `id`. */
export function DisabledReason({ id, reason, fix }: Lock & { id?: string }): React.JSX.Element {
  return (
    <p id={id} className="m-0 flex flex-wrap items-center gap-1 text-xs opacity-80" data-slot="disabled-reason">
      <span className="codicon codicon-lock" aria-hidden="true" />
      <span>{reason}</span>
      {fix ? <Button type="button" size="xs" variant="link" className="px-0" onClick={fix.run}>{fix.label}</Button> : null}
    </p>
  )
}
