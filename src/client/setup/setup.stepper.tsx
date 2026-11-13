// The wizard's progress: a vertical numbered list (done = check on a filled circle, current = ring,
// skipped = circle-slash on a dashed ring, upcoming = muted number; Welcome's card uses the same icons)
// that collapses to a segmented progress bar below `sm`. Answered steps and steps before the current one
// are buttons (go back); the current and upcoming ones are plain items.
import { Button } from '@/components/ui/button'
import { SETUP_STEPS, type SetupState, type SetupStep } from '../../shared/settings.setup'
import { SETUP_TEXT } from './setup.labels'

export type StepKind = 'done' | 'skipped' | 'current' | 'todo'

/** Each step's kind; `current` null = the Done panel is showing (every step shows its answer). */
export function stepKinds(current: SetupStep | null, answers: SetupState['steps']): Record<SetupStep, StepKind> {
  return Object.fromEntries(SETUP_STEPS.map((s) => [s, s === current ? 'current' : answers[s] ?? 'todo'])) as Record<SetupStep, StepKind>
}

function Marker({ kind, n }: { kind: StepKind; n: number }): React.JSX.Element {
  return (
    <span className="setup-marker" data-kind={kind} aria-hidden="true">
      {kind === 'done' ? <span className="codicon codicon-check" /> : kind === 'skipped' ? <span className={`codicon codicon-${SETUP_TEXT.stateIcon.skipped}`} /> : n}
    </span>
  )
}

export function SetupStepper({ current, answers, go }: {
  current: SetupStep | null
  answers: SetupState['steps']
  go(step: SetupStep): void
}): React.JSX.Element {
  const kinds = stepKinds(current, answers)
  const at = current === null ? SETUP_STEPS.length : SETUP_STEPS.indexOf(current)
  return (
    <nav aria-label={SETUP_TEXT.progress} className="shrink-0 sm:w-48 sm:border-r sm:border-(--vscode-widget-border,var(--vscode-panel-border)) sm:bg-(--vscode-sideBar-background,transparent)">
      <ol className="m-0 flex list-none flex-col gap-0.5 p-3 max-sm:hidden">
        {SETUP_STEPS.map((s, i) => {
          const kind = kinds[s]
          const body = (
            <>
              <Marker kind={kind} n={i + 1} />
              <span className="flex min-w-0 flex-col items-start">
                <span className={kind === 'current' ? 'font-semibold' : kind === 'todo' ? 'text-(--vscode-descriptionForeground)' : ''}>{SETUP_TEXT.steps[s]}</span>
                {kind === 'done' || kind === 'skipped' ? <span className="text-[11px] text-(--vscode-descriptionForeground)">{SETUP_TEXT.state[kind]}</span> : null}
              </span>
              {kind === 'current' || kind === 'todo' ? <span className="sr-only"> ({SETUP_TEXT.state[kind]})</span> : null}
            </>
          )
          const reachable = kind !== 'current' && (kind !== 'todo' || i < at)
          return (
            <li key={s} data-step={s} data-state={kind} aria-current={kind === 'current' ? 'step' : undefined}>
              {reachable ? (
                <Button variant="ghost" className="h-auto min-h-9 w-full justify-start gap-2 px-2 py-1 text-left" onClick={() => go(s)}>{body}</Button>
              ) : (
                <div className="flex min-h-9 items-center gap-2 px-2 py-1 text-xs">{body}</div>
              )}
            </li>
          )
        })}
      </ol>
      {/* Narrow: the header already says "Step n of 4"; the bar is the picture of it. */}
      <div className="flex gap-1 px-5 pt-3 sm:hidden" aria-hidden="true" data-setup-progress>
        {SETUP_STEPS.map((s) => <span key={s} className="setup-progress__seg" data-kind={kinds[s]} />)}
      </div>
    </nav>
  )
}
