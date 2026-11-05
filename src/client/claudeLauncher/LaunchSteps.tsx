// Stage list of a launch test: one row per stage with a check or a cross and the fix hint.
import type { LaunchStep } from './claudeLaunch.client'

export const STAGE_LABEL: Record<LaunchStep['stage'], string> = { wrapper: 'Wrapper', claude: 'Claude CLI', auth: 'Sign-in' }

export function LaunchSteps({ steps }: { steps: readonly LaunchStep[] }): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs" aria-label="Launch test result">
      {steps.map((s) => (
        <li key={s.stage} data-stage={s.stage} data-ok={s.ok}>
          <span aria-hidden="true" className={s.ok ? 'text-green-600' : 'text-destructive'}>{s.ok ? '✓' : '✗'}</span>{' '}
          <span className="opacity-70">{STAGE_LABEL[s.stage]}:</span> {s.message}
          {s.hint ? <span className="block pl-4 opacity-70">{s.hint}</span> : null}
        </li>
      ))}
    </ul>
  )
}
