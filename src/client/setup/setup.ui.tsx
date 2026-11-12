// Shared pieces of the wizard steps: option tiles (one-of-N, no typing) and the step footer with
// Back / Skip / Continue, the "Change later" link (opens Settings on that setting) and the save error with Retry.
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import type { CapabilitiesLoad } from '../useCapabilities'
import { SETUP_TEXT } from './setup.labels'
import { openSettingsAt, type SettingsFieldId } from '../settings.link'

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
}): React.JSX.Element {
  return (
    <div role="group" aria-label={p.label} className="flex flex-col gap-1">
      {p.options.map((o) => (
        <Button key={o} variant={p.value === o ? 'default' : 'outline'} aria-pressed={p.value === o}
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
 * step stays) or null (the step is done). Skip leaves the step unchanged on the server. `locked` =
 * why Continue cannot run yet (shown under it).
 */
export function StepFooter({ nav, where, at, commit, locked }: {
  nav: StepNav
  where: string
  /** The setting `where` names: the "Change later" link reveals it (Settings opens over the wizard). */
  at: { section: string; field: SettingsFieldId }
  commit?: () => Promise<string | null>
  locked?: string
}): React.JSX.Element {
  const last = nav.index === nav.total - 1
  // No toast: the failure line plus Continue turning into Retry is the whole failure surface.
  const cont = useAction(async () => {
    const failed = commit ? await commit() : null
    if (!failed) nav.next()
    return failed
  }, { label: last ? SETUP_TEXT.finish : SETUP_TEXT.next, ok: (f) => f === null, success: (f) => f ?? SETUP_TEXT.saved, toast: 'never' })
  const error = cont.result !== null && !cont.result.ok
  const busy = cont.busy
  return (
    <div className="mt-auto flex flex-col gap-2 pt-2">
      <Button size="xs" variant="link" className="h-auto self-start px-0 text-xs opacity-70" onClick={() => openSettingsAt(at.section, at.field)}>
        {SETUP_TEXT.changeLater(where)}
      </Button>
      {error ? <ActionResult action={cont} /> : null}
      <div className="flex items-center gap-2">
        {nav.index > 0 ? <Button size="sm" variant="ghost" disabled={busy} onClick={nav.back}>{SETUP_TEXT.back}</Button> : null}
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={busy} onClick={nav.skip}>{SETUP_TEXT.skip}</Button>
        <ActionButton size="sm" action={cont} busyLabel={SETUP_TEXT.saving} lock={locked ? { reason: locked } : undefined}>
          {error ? SETUP_TEXT.retry : last ? SETUP_TEXT.finish : SETUP_TEXT.next}
        </ActionButton>
      </div>
    </div>
  )
}

/** Retry for a step whose settings failed to load: busy while it reloads; the step's alert above says why. */
export function LoadRetry({ load }: { load(): Promise<CapabilitiesLoad> }): React.JSX.Element {
  const retry = useAction(load, { label: SETUP_TEXT.retry, ok: (r) => r.ok, toast: 'never' })
  return <ActionButton size="sm" variant="outline" className="self-start" action={retry} busyLabel={SETUP_TEXT.retrying}>{SETUP_TEXT.retry}</ActionButton>
}
