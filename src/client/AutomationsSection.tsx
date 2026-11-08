// Settings › Automations: routines that run agents for you (RoutinesPanel).
import { RoutinesPanel } from './RoutinesPanel'

/** Automations section body. */
export function AutomationsSection(): React.JSX.Element {
  return <div className="flex flex-col gap-3 text-[13px]" data-testid="automations-section"><RoutinesPanel /></div>
}
