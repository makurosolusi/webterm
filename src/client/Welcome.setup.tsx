// Welcome's "Finish setup" card: one row per first-run step, shown until the wizard is completed.
import { Button } from '@/components/ui/button'
import { SETUP_STEPS, type SetupState, type SetupStep } from '../shared/settings'

/** Row label per wizard step, in `SETUP_STEPS` order. */
export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  claude: 'Claude',
  browser: 'Browser',
  central: 'Central Agent',
  basics: 'Basics',
}

const MARK = { done: { icon: 'check', text: 'done' }, skipped: { icon: 'dash', text: 'skipped' }, unset: { icon: 'close', text: 'not set' } } as const

/** Setup checklist card; renders nothing once `setup.completedAt` is set. */
export function SetupChecklist({ setup, onOpen }: { setup: SetupState; onOpen: (step?: SetupStep) => void }) {
  if (setup.completedAt != null) return null
  const done = SETUP_STEPS.filter((s) => setup.steps[s] === 'done').length
  return (
    <section className="welcome__section welcome__setup" aria-labelledby="welcome-setup">
      <h2 id="welcome-setup" className="welcome__heading">Finish setup · {done} of {SETUP_STEPS.length}</h2>
      <ul className="welcome__list">
        {SETUP_STEPS.map((step) => {
          const mark = MARK[setup.steps[step] ?? 'unset']
          return (
            <li key={step}>
              <Button type="button" variant="link" className="welcome__link" onClick={() => onOpen(step)}>
                <span className={`codicon codicon-${mark.icon}`} aria-hidden />
                <span>{SETUP_STEP_LABELS[step]}</span>
                <span className="welcome__path">{mark.text}</span>
              </Button>
            </li>
          )
        })}
      </ul>
      <Button type="button" className="welcome__setup-cta" onClick={() => onOpen()}>Set up webterm</Button>
    </section>
  )
}
