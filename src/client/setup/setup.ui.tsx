// Shared pieces of the wizard steps: the step page (heading, one-line description, scrolling body, the
// quiet "change later" line and the sticky footer), option tiles (one-of-N, no typing), the footer with
// Back / Skip / Continue plus the save error with Retry, and the load state of a step that reads the server.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import type { SetupStep } from '../../shared/settings.setup'
import type { CapabilitiesLoad } from '../useCapabilities'
import { SettingsMessage } from '../SettingsMessage'
import { SETUP_TEXT } from './setup.labels'
import { openSettingsAt, type SettingsFieldId } from '../settings.link'
import './setup.css'

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

/** The setting a step's "change later" line names; Settings opens over the wizard and reveals it. */
export interface StepSetting { where: string; section: string; field: SettingsFieldId }

/** A focusable heading that takes focus when it mounts: a new step (or the Done panel) is announced, and
 *  focus never falls to <body> when the button that moved on unmounts. */
export function StepHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  return <h3 ref={ref} tabIndex={-1} data-setup-heading className="m-0 text-[15px] font-semibold leading-5 outline-none">{children}</h3>
}

/** One step screen: heading and description, then the body (scrolls), then the sticky footer. */
export function StepPage({ step, setting, footer, children }: {
  step: SetupStep
  setting: StepSetting
  footer: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setup-step flex min-h-0 flex-1 flex-col" data-setup-step={step}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-1">
          <StepHeading>{SETUP_TEXT.steps[step]}</StepHeading>
          <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{SETUP_TEXT.description[step]}</p>
        </div>
        {children}
        <p className="m-0 mt-auto flex flex-wrap items-center gap-x-1 pt-2 text-xs text-(--vscode-descriptionForeground)">
          <span>{SETUP_TEXT.changeLater(setting.where)}</span>
          <Button size="xs" variant="link" className="h-auto min-h-0 px-0" onClick={() => openSettingsAt(setting.section, setting.field)}>{SETUP_TEXT.openSettings}</Button>
        </p>
      </div>
      {footer}
    </div>
  )
}

/** One-of-N choice as large outline tiles (aria-pressed; Tab/Enter). The chosen one has the accent border and a check. */
export function Tiles<T extends string>(p: {
  label: string
  options: readonly T[]
  names: Record<T, string>
  help?: Partial<Record<T, string>>
  value: T
  onChange(v: T): void
}): React.JSX.Element {
  return (
    <div role="group" aria-label={p.label} className="flex flex-col gap-1.5">
      {p.options.map((o) => (
        <Button key={o} variant="outline" aria-pressed={p.value === o} data-tile
          className="setup-tile h-auto min-h-9 justify-start gap-2 whitespace-normal px-3 py-1.5 text-left" onClick={() => p.onChange(o)}>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="[overflow-wrap:anywhere]">{p.names[o]}</span>
            {p.help?.[o] ? <span className="text-xs text-(--vscode-descriptionForeground)">{p.help[o]}</span> : null}
          </span>
          <span className={`codicon codicon-check setup-tile__check${p.value === o ? '' : ' invisible'}`} aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}

/**
 * Footer of a step (sticky, top border). `commit` runs on Continue and resolves an error message (shown
 * with Retry, the step stays) or null (the step is done). Skip leaves the step unchanged on the server.
 * `locked` = why Continue cannot run yet. `notice` = one line that never blocks (e.g. not tested yet).
 */
export function StepFooter({ nav, commit, locked, notice }: {
  nav: StepNav
  commit?: () => Promise<string | null>
  locked?: string
  notice?: string
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
    <div className="flex shrink-0 flex-col gap-2 border-t border-(--vscode-widget-border,var(--vscode-panel-border)) px-5 py-3" data-setup-footer>
      {notice && !error ? (
        <p role="status" data-setup-notice className="m-0 flex items-start gap-1.5 text-xs text-(--vscode-descriptionForeground)">
          <span className="codicon codicon-info mt-px" aria-hidden="true" />{notice}
        </p>
      ) : null}
      {error ? <ActionResult action={cont} /> : null}
      <div className="flex items-center gap-2">
        {nav.index > 0 ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={nav.back}>
            <span className="codicon codicon-arrow-left" aria-hidden="true" />{SETUP_TEXT.back}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={nav.skip}>{SETUP_TEXT.skip}</Button>
        <ActionButton size="sm" className="min-w-20" action={cont} busyLabel={SETUP_TEXT.saving} lock={locked ? { reason: locked } : undefined}>
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

/** A step still reading the server: loading line, or the failure with Retry; Continue waits for it. */
export function StepLoading({ step, setting, nav, error, loading, failed, retry }: {
  step: SetupStep
  setting: StepSetting
  nav: StepNav
  error: unknown
  loading: string
  failed: string
  retry(): Promise<CapabilitiesLoad>
}): React.JSX.Element {
  return (
    <StepPage step={step} setting={setting} footer={<StepFooter nav={nav} locked={SETUP_TEXT.waitForLoad} />}>
      <SettingsMessage kind={error ? 'error' : 'loading'}>{error ? failed : loading}</SettingsMessage>
      {error ? <LoadRetry load={retry} /> : null}
    </StepPage>
  )
}
