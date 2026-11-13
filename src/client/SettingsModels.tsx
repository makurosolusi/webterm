// Settings › Claude › Models: the model ladder picks the model and effort per task, so this is read-only:
// one line plus the ladder, folded. Per-workspace overrides (`projectModels`) are still honoured by the
// server (models/modelOverride.ts) but no longer edited here; the workspace menu has no settings hook yet.
import { TIER_TABLE, type Tier } from '../server/models/modelLadder'
import { Field } from './SettingsFields'

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
/** Effort in words; the ladder's ids (xhigh) are not product text. */
const EFFORT_LABEL: Readonly<Record<string, string>> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** What each rung is used for; model + effort come from the ladder's own table. */
const LADDER_ROWS: readonly { tier: Exclude<Tier, 'T0'>; use: string }[] = [
  { tier: 'T1', use: 'Helpers and quick exploration' },
  { tier: 'T2', use: 'Default: Central, routines, reviews, workers' },
  { tier: 'T3', use: 'Planners and complex tasks' },
  { tier: 'T4', use: 'Only when you ask for it' },
]

export const MODELS_TEXT = {
  label: 'Models',
  hint: 'Models are chosen automatically: each task gets a fitting model, a stronger one after a failure, and cheaper ones near your daily limit.',
  show: 'Show which model does what',
} as const

export function ModelsSettings(): React.JSX.Element {
  return (
    <Field label="Models" block field="model-ladder" hint={MODELS_TEXT.hint}>
      <details className="st-models-ladder">
        <summary>{MODELS_TEXT.show}</summary>
        <table className="st-table" aria-label="Model ladder defaults">
          <thead><tr><th>Model</th><th>Effort</th><th>Used for</th></tr></thead>
          <tbody>
            {LADDER_ROWS.map((r) => (
              <tr key={r.tier}><td>{cap(TIER_TABLE[r.tier].model ?? '')}</td><td>{EFFORT_LABEL[TIER_TABLE[r.tier].effort ?? ''] ?? ''}</td><td>{r.use}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </Field>
  )
}
