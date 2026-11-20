// Feedback for async buttons: busy while running (at least `minBusyMs`, so it never just flickers),
// then an inline result with the time, and on failure a toast with Retry. Every result bumps `seq`,
// so pressing again with the same answer still visibly re-renders (new time, re-announced).
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { DisabledReason, type Lock } from '@/components/ui/disabled-reason'
import { VscodeNotification } from '@/components/vscode/vscodeNotification'

/** `quiet` = started with `run({ quiet: true })` (e.g. an automatic first check): inline only, no toast. */
export interface ActionOutcome { seq: number; at: number; ok: boolean; text: string; quiet?: boolean }

export interface ActionOptions<T> {
  /** Operation name, used in the default failure text and the toast title ("Check again"). */
  label?: string
  /** Inline text for a result. */
  success?(r: T): string
  /** Whether a resolved result counts as success (default true); false shows it as a failure. */
  ok?(r: T): boolean
  /** Inline text for a thrown error; default "<label> failed: <cause>". */
  failure?(e: unknown): string
  /** When to also show a toast (default 'failure'). */
  toast?: 'failure' | 'always' | 'never'
  /** Shortest busy state (default 400 ms). */
  minBusyMs?: number
}

export interface Action<T = unknown> {
  /** Starts the action; ignored (resolves undefined) while one is running. */
  run(opts?: { quiet?: boolean }): Promise<T | undefined>
  busy: boolean
  result: ActionOutcome | null
  label: string
  toast: 'failure' | 'always' | 'never'
}

const DEFAULT_MIN_BUSY_MS = 400
const MAX_CAUSE_CHARS = 200
const TOKEN_LIKE = /[A-Za-z0-9_\-+/=]{32,}/g
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The error's message, shortened, with token-like runs masked: a failure line must never show a secret. */
export function errorCause(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error'
  return raw.replace(TOKEN_LIKE, '***').slice(0, MAX_CAUSE_CHARS)
}

/** Runs `fn` with busy state and a result line; see ActionButton / ActionResult. */
export function useAction<T>(fn: () => Promise<T>, opts: ActionOptions<T> = {}): Action<T> {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionOutcome | null>(null)
  const running = useRef(false)
  const seq = useRef(0)
  // A run outlives its component (minBusyMs wait, slow fn): setState after unmount touches React/window
  // for nothing, and throws once the DOM environment is torn down (seen as an unhandled error in tests).
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const latest = useRef({ fn, opts })
  latest.current = { fn, opts }
  const label = opts.label ?? 'Action'

  const run = useCallback(async (runOpts?: { quiet?: boolean }): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true
    setBusy(true)
    const started = Date.now()
    const { fn: f, opts: o } = latest.current
    let outcome: Omit<ActionOutcome, 'seq' | 'at'>
    let value: T | undefined
    try {
      value = await f()
      outcome = { ok: o.ok?.(value) ?? true, text: o.success?.(value) ?? 'Done' }
    } catch (e) {
      outcome = { ok: false, text: o.failure?.(e) ?? `${o.label ?? 'Action'} failed: ${errorCause(e)}` }
    }
    const wait = (o.minBusyMs ?? DEFAULT_MIN_BUSY_MS) - (Date.now() - started)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    running.current = false
    if (!mounted.current) return value
    seq.current += 1
    setResult({ ...outcome, quiet: runOpts?.quiet, seq: seq.current, at: Date.now() })
    setBusy(false)
    return value
  }, [])

  return { run, busy, result, label, toast: opts.toast ?? 'failure' }
}

type ActionButtonProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  action: Action<unknown>
  busyLabel: string
  /** Locked by another setting: disabled, with the reason as tooltip and a line under it. */
  lock?: Lock
  onClick?: ComponentProps<typeof Button>['onClick']
}

/** Button that runs `action`: disabled + aria-busy + spinner + `busyLabel` while it runs. */
export function ActionButton({ action, busyLabel, lock, disabled, children, onClick, ...rest }: ActionButtonProps): React.JSX.Element {
  const button = (
    <Button {...rest} disabled={disabled || action.busy || lock !== undefined} aria-busy={action.busy}
      onClick={(e) => { onClick?.(e); void action.run() }}>
      {action.busy ? <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> : null}
      {action.busy ? busyLabel : children}
    </Button>
  )
  if (!lock) return button
  return (
    <span className="inline-flex flex-col gap-0.5">
      <IconTooltip label={typeof children === 'string' ? children : action.label} disabled disabledReason={lock.reason}>{button}</IconTooltip>
      <DisabledReason {...lock} />
    </span>
  )
}

/** Inline result of the last run ("Detected: Claude · checked 10:42:05"); on failure also a toast with Retry. */
export function ActionResult({ action, stamp, retryLabel = 'Retry', children }: {
  action: Action<unknown>
  /** Word before the time, e.g. "checked". */
  stamp?: string
  retryLabel?: string
  /** Extra detail under the line (e.g. fix steps). */
  children?: ReactNode
}): React.JSX.Element | null {
  const [closed, setClosed] = useState(0)
  const r = action.result
  if (!r) return null
  const toast = !r.quiet && (action.toast === 'always' || (action.toast === 'failure' && !r.ok))
  return (
    <>
      <div key={r.seq} className="flex flex-col gap-1 text-xs" data-action-result={r.ok ? 'ok' : 'failed'} data-seq={r.seq}>
        <p role={r.ok ? 'status' : 'alert'} className="m-0">
          <span className={`codicon ${r.ok ? 'codicon-pass' : 'codicon-error text-destructive'} mr-1 align-middle`} aria-hidden="true" />
          <span>{r.text}</span><span className="opacity-60">{` · ${stamp ? `${stamp} ` : ''}${clock(r.at)}`}</span>
        </p>
        {children}
      </div>
      {toast && closed !== r.seq ? (
        <VscodeNotification id={`action-result-${r.seq}`} severity={r.ok ? 'info' : 'error'} title={r.ok ? action.label : `${action.label} failed`}
          message={r.text} onClose={() => setClosed(r.seq)}
          actions={r.ok ? undefined : [{ label: retryLabel, onClick: () => { setClosed(r.seq); void action.run() } }]} />
      ) : null}
    </>
  )
}
