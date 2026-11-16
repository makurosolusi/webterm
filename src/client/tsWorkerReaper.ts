/**
 * Monaco's TypeScript and JavaScript language workers never stop on their own (the css/html/json
 * ones have an idle timeout, these two do not). Once a .ts/.js model has been opened, the worker
 * stays resident for the rest of the session. This module stops it again after the last model of
 * that language is gone.
 *
 * Stopping is done through the supported side door: re-applying the current compiler options makes
 * Monaco tear the worker down, and the next request starts a fresh one with identical options.
 *
 * The decision logic is Monaco-free so it can run under node: the caller injects the live-language
 * lookup and the stop action; tests inject fakes plus fake timers.
 */

/** Languages whose worker has no idle shutdown of its own; each has its own worker manager. */
export const TS_WORKER_LANGUAGES = ['typescript', 'javascript'] as const
export type TsWorkerLanguage = (typeof TS_WORKER_LANGUAGES)[number]

/** Delay between the last model leaving and the worker being stopped (2 minutes). */
export const TS_WORKER_STOP_GRACE_MS = 120_000

export interface TsWorkerReaperDeps {
  /** Language ids of every model that is currently alive. */
  liveLanguageIds(): readonly string[]
  /** Stop the worker serving this language. */
  stopWorker(language: TsWorkerLanguage): void
  graceMs?: number
}

export interface TsWorkerReaper {
  /** A model with this language was created or switched to it. */
  modelEntered(language: string): void
  /** A model with this language is being disposed or switched away from it. */
  modelLeft(language: string): void
  /** Cancel any scheduled sweep. */
  dispose(): void
}

const asWorkerLanguage = (language: string): TsWorkerLanguage | undefined =>
  TS_WORKER_LANGUAGES.find((known) => known === language)

class Reaper implements TsWorkerReaper {
  // Languages with a worker that may be running (a model of that language appeared since the
  // last stop). Languages never seen are skipped so we do not trigger pointless re-diagnosis.
  private readonly running = new Set<TsWorkerLanguage>()
  private sweepTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: TsWorkerReaperDeps) {}

  modelEntered(language: string): void {
    const known = asWorkerLanguage(language)
    if (known) this.running.add(known)
  }

  modelLeft(language: string): void {
    const known = asWorkerLanguage(language)
    if (!known || !this.running.has(known)) return
    // Single shared timer: every departure restarts the countdown.
    this.cancel()
    this.sweepTimer = setTimeout(() => this.sweep(), this.deps.graceMs ?? TS_WORKER_STOP_GRACE_MS)
  }

  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    clearTimeout(this.sweepTimer)
    this.sweepTimer = undefined
  }

  // Re-query the live models at sweep time rather than counting events: the dispose event fires
  // before the model leaves the live list, so a count taken then would be off by one.
  private sweep(): void {
    this.sweepTimer = undefined
    const alive = this.deps.liveLanguageIds()
    for (const language of [...this.running]) {
      if (alive.includes(language)) continue
      this.running.delete(language)
      this.deps.stopWorker(language)
    }
  }
}

export function createTsWorkerReaper(deps: TsWorkerReaperDeps): TsWorkerReaper {
  return new Reaper(deps)
}
