// Opening and closing the first-run wizard goes through the URL (`?setup=1` resume, `?setup=<step>`),
// like every other overlay (`appRoute.ts`): a reload or a shared link lands on the same step.
import { SETUP_STEPS, type SetupState, type SetupStep } from '../../shared/settings.setup'
import { appNavigate, useAppRoute, type SetupRoute } from '../appRoute'

/** Open the wizard on `step`, or at the first unfinished step. No-op before `AppRouteSync` mounts. */
export function openSetup(step?: SetupStep): void {
  appNavigate()?.setSetup(step ?? 'resume')
}

/** The wizard's URL state plus setters, for React callers inside the router. */
export function useSetupRoute(): { step: SetupRoute | null; open(step?: SetupStep): void; close(): void } {
  const { route, actions } = useAppRoute()
  return {
    step: route.setup,
    open: (step) => actions.setSetup(step ?? 'resume'),
    close: () => actions.setSetup(null),
  }
}

/** First step neither done nor skipped; all answered = the first step (the wizard is being re-run). */
export function resumeStep(state: SetupState): SetupStep {
  return SETUP_STEPS.find((s) => !state.steps[s]) ?? SETUP_STEPS[0]
}
