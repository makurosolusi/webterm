// Welcome's "Finish setup" card: one row per first-run step, shown until the wizard is completed. Icons and
// state words are the wizard stepper's (SETUP_TEXT.stateIcon / .state), so both read the same.
import { Button } from '@/components/ui/button'
import { SETUP_STEPS, type SetupState, type SetupStep } from '../shared/settings'
import { SETUP_TEXT } from './setup/setup.labels'

/** Row label per wizard step, in `SETUP_STEPS` order (the wizard's own names). */
export const SETUP_STEP_LABELS: Record<SetupStep, string> = SETUP_TEXT.steps

/** Setup checklist card; renders nothing once `setup.completedAt` is set. */
export function SetupChecklist({ setup, onOpen }: { setup: SetupState; onOpen: (step?: SetupStep) => void }) {
  if (setup.completedAt != null) return null
  const done = SETUP_STEPS.filter((s) => setup.steps[s] === 'done').length
  return (
    <section className="welcome__section welcome__setup" aria-labelledby="welcome-setup">
      <h2 id="welcome-setup" className="welcome__heading">Finish setup · {done} of {SETUP_STEPS.length}</h2>
      <ul className="welcome__list">
        {SETUP_STEPS.map((step) => {
          const state = setup.steps[step] ?? 'todo'
          return (
            <li key={step}>
              <Button type="button" variant="link" className="welcome__link" onClick={() => onOpen(step)}>
                <span className={`codicon codicon-${SETUP_TEXT.stateIcon[state]}`} aria-hidden />
                <span>{SETUP_STEP_LABELS[step]}</span>
                <span className="welcome__path">{SETUP_TEXT.state[state]}</span>
              </Button>
            </li>
          )
        })}
      </ul>
      <Button type="button" className="welcome__setup-cta" onClick={() => onOpen()}>{SETUP_TEXT.title}</Button>
    </section>
  )
}
