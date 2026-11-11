// Settings › Agent › Models: what the model ladder picks by default, per-workspace overrides
// (`projectModels`, an entry key: each row writes only its own entry, `null` removes it). The daily
// spending limit that pulls the ladder down lives in Settings › Central Agent › Model & cost.
import { useEffect, useState } from 'react'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import {
  PROJECT_MODEL_ALIASES, PROJECT_MODEL_EFFORTS, type ProjectModelAlias, type ProjectModelEffort, type ProjectModelOverride,
} from '../shared/settings.projectModels'
import { TIER_TABLE, type Tier } from '../server/models/modelLadder'
import { fetchWorkspaces } from './api'
import { Field } from './SettingsFields'
import { SettingsSelect } from './SettingsControls'

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** What each rung is used for; model + effort come from the ladder's own table. */
const LADDER_ROWS: readonly { tier: Exclude<Tier, 'T0'>; use: string }[] = [
  { tier: 'T1', use: 'Helpers and quick exploration' },
  { tier: 'T2', use: 'Default: Central, routines, reviews, workers' },
  { tier: 'T3', use: 'Planners and complex tasks' },
  { tier: 'T4', use: 'Only when you ask for it' },
]

const MODEL_OPTIONS = [{ value: '', label: 'Auto' }, ...PROJECT_MODEL_ALIASES.map((m) => ({ value: m, label: cap(m) }))]
const EFFORT_OPTIONS = [{ value: '', label: 'Auto' }, ...PROJECT_MODEL_EFFORTS.map((e) => ({ value: e, label: e }))]

/** An override from the two selects; null when both are Auto (= remove, the ladder decides). */
function overrideOf(model: string, effort: string): ProjectModelOverride | null {
  if (!model && !effort) return null
  return { ...(model ? { model: model as ProjectModelAlias } : {}), ...(effort ? { effort: effort as ProjectModelEffort } : {}) }
}

export function ModelsSettings({ settings: s, onChange }: { settings: Settings; onChange: (patch: SettingsPatch) => void }): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>()
  const [wsError, setWsError] = useState<string>()
  useEffect(() => {
    fetchWorkspaces().then((list) => setWorkspaces(list.map((w) => ({ id: w.id, name: w.name }))))
      .catch((err: unknown) => setWsError(err instanceof Error ? err.message : String(err)))
  }, [])
  const nameOf = (id: string): string => workspaces?.find((w) => w.id === id)?.name ?? id
  const write = (id: string, next: ProjectModelOverride | null): void => onChange({ projectModels: { [id]: next } })

  const free = (workspaces ?? []).filter((w) => !s.projectModels[w.id])
  const [pick, setPick] = useState({ ws: '', model: '', effort: '' })
  const pickWs = pick.ws && free.some((w) => w.id === pick.ws) ? pick.ws : ''
  const pending = overrideOf(pick.model, pick.effort)

  return (
    <>
      <Field label="Models" block field="model-ladder"
        hint="A model ladder picks the model and effort for each task, steps up after a failure, and moves to cheaper models near your spending limit.">
        <table className="st-table" aria-label="Model ladder defaults">
          <thead><tr><th>Model</th><th>Effort</th><th>Used for</th></tr></thead>
          <tbody>
            {LADDER_ROWS.map((r) => (
              <tr key={r.tier}><td>{cap(TIER_TABLE[r.tier].model ?? '')}</td><td>{TIER_TABLE[r.tier].effort}</td><td>{r.use}</td></tr>
            ))}
          </tbody>
        </table>
      </Field>

      <Field label="Per-workspace model" setting="projectModels" block
        hint="Pin a model or effort for one workspace. Auto leaves that choice to the ladder.">
        {wsError ? <p role="alert" className="st-hint">{`Could not load workspaces: ${wsError}`}</p> : null}
        <div className="st-rows">
          {Object.entries(s.projectModels).map(([id, o]) => (
            <div key={id} className="st-row" aria-label={`Override for ${nameOf(id)}`}>
              <span className="st-row-label" title={nameOf(id)}>{nameOf(id)}</span>
              <SettingsSelect ariaLabel={`Model for ${nameOf(id)}`} value={o.model ?? ''} options={MODEL_OPTIONS}
                onChange={(v) => write(id, overrideOf(v, o.effort ?? ''))} />
              <SettingsSelect ariaLabel={`Effort for ${nameOf(id)}`} value={o.effort ?? ''} options={EFFORT_OPTIONS}
                onChange={(v) => write(id, overrideOf(o.model ?? '', v))} />
              <button type="button" className="st-button" onClick={() => write(id, null)}>Remove</button>
            </div>
          ))}
          {Object.keys(s.projectModels).length === 0 ? <p className="st-hint">No overrides: every workspace uses the ladder.</p> : null}
          <div className="st-row">
            <SettingsSelect ariaLabel="Workspace" value={pickWs} disabled={!workspaces || free.length === 0}
              options={[{ value: '', label: !workspaces ? 'Loading workspaces…' : free.length ? 'Choose a workspace' : 'All workspaces have an override' },
                ...free.map((w) => ({ value: w.id, label: w.name }))]}
              onChange={(v) => setPick((p) => ({ ...p, ws: v }))} />
            <SettingsSelect ariaLabel="New override model" value={pick.model} options={MODEL_OPTIONS}
              onChange={(v) => setPick((p) => ({ ...p, model: v }))} />
            <SettingsSelect ariaLabel="New override effort" value={pick.effort} options={EFFORT_OPTIONS}
              onChange={(v) => setPick((p) => ({ ...p, effort: v }))} />
            <button type="button" className="st-button" disabled={!pickWs || !pending}
              onClick={() => { write(pickWs, pending); setPick({ ws: '', model: '', effort: '' }) }}>Add override</button>
          </div>
        </div>
      </Field>

    </>
  )
}
