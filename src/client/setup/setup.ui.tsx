// Shared pieces of the wizard steps: option tiles (one-of-N, no typing) and the step footer with
// Back / Skip / Continue, the "Change later" line and the save error with Retry.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SETUP_TEXT } from './setup.labels'

/** Where a step sits in the wizard and how to leave it; the dialog owns the progress PATCH. */
export interface StepNav {
  index: number
  total: number
  back(): void
  skip(): void
  /** Mark the step done and move on (Finish on the last step). */
  next(): void
}

/** Per-step props: navigation plus the Settings path printed under the step. */
export interface StepProps { nav: StepNav }

/** One-of-N choice as large buttons (radiogroup semantics through aria-pressed, keyboard via Tab/Enter). */
export function Tiles<T extends string>(p: {
  label: string
  options: readonly T[]
  names: Record<T, string>
  help?: Partial<Record<T, string>>
  value: T
  onChange(v: T): void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div role="group" aria-label={p.label} className="flex flex-col gap-1">
      {p.options.map((o) => (
        <Button key={o} variant={p.value === o ? 'default' : 'outline'} aria-pressed={p.value === o} disabled={p.disabled}
          className="h-auto min-h-8 flex-col items-start justify-start whitespace-normal py-1 text-left" onClick={() => p.onChange(o)}>
          <span className="[overflow-wrap:anywhere]">{p.names[o]}</span>
          {p.help?.[o] ? <span className="text-xs font-normal opacity-80">{p.help[o]}</span> : null}
        </Button>
      ))}
    </div>
  )
}

/**
 * Footer of a step. `commit` runs on Continue and resolves an error message (shown with Retry, the
 * step stays) or null (the step is done). Skip leaves the step unchanged on the server.
 */
export function StepFooter({ nav, where, commit, disabled }: {
  nav: StepNav
  where: string
  commit?: () => Promise<string | null>
  disabled?: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const last = nav.index === nav.total - 1
  const onContinue = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = commit ? await commit() : null
    setBusy(false)
    if (failed) setError(failed)
    else nav.next()
  }
  return (
    <div className="mt-auto flex flex-col gap-2 pt-2">
      <p className="m-0 text-xs opacity-70">{SETUP_TEXT.changeLater(where)}</p>
      {error ? <p role="alert" className="m-0 text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        {nav.index > 0 ? <Button size="sm" variant="ghost" disabled={busy} onClick={nav.back}>{SETUP_TEXT.back}</Button> : null}
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={busy} onClick={nav.skip}>{SETUP_TEXT.skip}</Button>
        <Button size="sm" disabled={busy || disabled} onClick={() => void onContinue()}>
          {busy ? SETUP_TEXT.saving : error ? SETUP_TEXT.retry : last ? SETUP_TEXT.finish : SETUP_TEXT.next}
        </Button>
      </div>
    </div>
  )
}
