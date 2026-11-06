// A workspace action that failed (switch, focus, close session, rename, delete, create from a
// shortcut, reopen) is reported instead of vanishing as an unhandled rejection: a sticky error
// notice naming the action and its cause, with Retry when the action can simply run again, and
// one console line with the operation + id for the Output panel (data-209-5).
import { ACTION_NOTICE_KEY, showNotice } from './workspaceSave.notice'
import { isAbortError } from './workspaceLifecycle.select'

export const ACTION_RETRY_LABEL = 'Retry'

const causeOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Report a failed workspace action. `what` is user-facing ("switch workspace"), `id` its target. */
export function reportActionError(what: string, id: string, err: unknown, retry?: () => void): void {
  console.error(`[webterm] ${what} (${id}) failed:`, err)
  showNotice(ACTION_NOTICE_KEY, {
    title: `Could not ${what}.`, message: causeOf(err), severity: 'error',
    actions: retry ? [{ label: ACTION_RETRY_LABEL, onClick: retry }] : undefined,
  })
}

/** Wrap an async action so it never rejects: a failure is reported (its first argument, the target
 *  id or name, as the id), with Retry re-running it. */
export function reported<A extends [string, ...unknown[]]>(what: string, run: (...args: A) => Promise<void>) {
  const safe = async (...args: A): Promise<void> => {
    try {
      await run(...args)
    } catch (err) {
      if (isAbortError(err)) return // superseded by a newer action, not a failure
      reportActionError(what, args[0], err, () => void safe(...args))
    }
  }
  return safe
}
