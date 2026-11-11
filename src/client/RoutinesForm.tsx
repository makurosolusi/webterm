// Create/edit form for one routine (Control › Automations › Routines). Schedule is a preset combobox
// (custom cron checked by the server's own parser); the check command, limits and timeouts sit
// under "More options". The server still validates everything and its error text is shown as-is.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cronError } from '../server/routines/routineCron'
import { SettingsCombobox } from './SettingsCombobox'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'
import { dollarsToMicros, validateDollars } from './SettingsCostLimit'
import {
  DEBOUNCE_CHOICES, MAX_RUNS_CHOICES, numberOptions, ROUTINE_EVENT_FIELD_ID, ROUTINE_EVENT_PRESETS, ROUTINE_MAX_COST_FIELD_ID,
  ROUTINE_MAX_COST_PRESETS, ROUTINE_SCHEDULE_FIELD_ID, ROUTINE_SCHEDULE_PRESETS, TIMEOUT_CHOICES,
} from './routineSchedule.presets'

export type RoutineTrigger = { type: 'schedule'; cron: string } | { type: 'event'; pattern: string; debounceMs?: number } | { type: 'api' }
export type RoutineAction = { type: 'spawn'; prompt: string } | { type: 'outbox'; to: string; body: string } | { type: 'prreview' }
export interface RoutineDef {
  name: string
  enabled: boolean
  workspaceId: string | null
  trigger: RoutineTrigger
  precheck: { command: string; timeoutSeconds: number } | null
  action: RoutineAction
  budget: { maxRunsPerDay: number; maxCostUsdPerDay: number | null }
}

export const ROUTINE_FORM_TEXT = {
  name: 'Name', workspace: 'Workspace', noWorkspace: 'Home folder',
  trigger: 'Start', schedule: 'On a schedule', event: 'When an event happens', api: 'Only when run by hand or from a script',
  cron: 'Schedule', cronHint: 'Pick one, or type a cron line (minute hour day month weekday), e.g. 30 8 * * 1-5.',
  pattern: 'Event', patternHint: 'Pick one, or type an event kind such as hook.Stop or fs.*.', debounce: 'Wait for events to settle',
  more: 'More options',
  precheck: 'Only run if this command succeeds', precheckHint: 'Optional. If the command fails, the run is skipped and spends nothing.',
  precheckTimeout: 'Give up on the command after',
  action: 'Action', spawn: 'Start a headless Claude agent', outbox: 'Message a wired agent', prreview: 'Review new pull requests',
  prreviewHint: 'Reviews open pull requests of the workspace folder whose head is new. Drafts wait in the Needs-you list of the Central chat; nothing is posted to GitHub until you approve it.',
  prreviewNeedsWorkspace: 'Pick a workspace: its folder is the repo whose pull requests are reviewed.',
  prompt: 'Prompt', to: 'Agent', noAgents: 'No agent on any board yet. Add one, then pick it here.', pickAgent: 'Pick an agent', body: 'Message',
  maxRuns: 'Most runs per day', maxCost: 'Most spend per day (USD)', enabled: 'Enabled',
  seconds: (n: number) => `${n} s`, runs: (n: number) => `${n} run${n === 1 ? '' : 's'}`,
  save: 'Save', cancel: 'Cancel',
} as const

export const EMPTY_ROUTINE: RoutineDef = {
  name: '', enabled: true, workspaceId: null, trigger: { type: 'schedule', cron: '0 9 * * 1' }, precheck: null,
  action: { type: 'spawn', prompt: '' }, budget: { maxRunsPerDay: 24, maxCostUsdPerDay: null },
}

const T = ROUTINE_FORM_TEXT
const field = 'flex flex-col gap-1'

/** An agent on a board, for the "Message a wired agent" picker. */
export interface RoutineAgentNode { id: string; title: string; workspaceId: string; workspaceName: string }

export function RoutinesForm(props: {
  initial: RoutineDef
  workspaces: { id: string; name: string }[]
  /** Agent nodes across boards; the picker shows the routine's workspace only once one is chosen. */
  agents?: RoutineAgentNode[]
  onSave(def: RoutineDef): void
  onCancel(): void
}): React.JSX.Element {
  const [d, setD] = useState<RoutineDef>(props.initial)
  const set = (patch: Partial<RoutineDef>): void => setD((prev) => ({ ...prev, ...patch }))
  const t = d.trigger
  const a = d.action
  return (
    <form className="mt-2 flex flex-col gap-2 rounded border p-2 text-xs" aria-label="Routine" onSubmit={(e) => { e.preventDefault(); props.onSave(d) }}>
      <label className={field}>{T.name}<Input value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label className={field}>{T.workspace}
        <SettingsSelect value={d.workspaceId ?? ''} onChange={(v) => set({ workspaceId: v || null })}
          options={[{ value: '', label: T.noWorkspace }, ...props.workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
      </label>
      <label className={field}>{T.trigger}
        <SettingsSelect value={t.type} options={[{ value: 'schedule', label: T.schedule }, { value: 'event', label: T.event }, { value: 'api', label: T.api }]}
          onChange={(type) => set({ trigger: type === 'schedule' ? { type, cron: '0 9 * * 1' } : type === 'event' ? { type, pattern: 'hook.Stop', debounceMs: 5000 } : { type: 'api' } })} />
      </label>
      {t.type === 'schedule' ? (
        <div className={field}>
          <label htmlFor="routine-schedule">{T.cron}</label>
          <SettingsCombobox id="routine-schedule" fieldId={ROUTINE_SCHEDULE_FIELD_ID} presets={ROUTINE_SCHEDULE_PRESETS} mono
            value={t.cron} validate={cronError} onCommit={(cron) => set({ trigger: { type: 'schedule', cron } })} />
          <span className="opacity-70">{T.cronHint}</span>
        </div>
      ) : null}
      {t.type === 'event' ? (
        <div className={field}>
          <label htmlFor="routine-event">{T.pattern}</label>
          <SettingsCombobox id="routine-event" fieldId={ROUTINE_EVENT_FIELD_ID} presets={ROUTINE_EVENT_PRESETS} mono
            value={t.pattern} onCommit={(pattern) => set({ trigger: { ...t, pattern: pattern.trim() } })} />
          <span className="opacity-70">{T.patternHint}</span>
        </div>
      ) : null}
      <label className={field}>{T.action}
        <SettingsSelect value={a.type} options={[{ value: 'spawn', label: T.spawn }, { value: 'outbox', label: T.outbox }, { value: 'prreview', label: T.prreview }]}
          onChange={(v) => set({ action: v === 'outbox' ? { type: 'outbox', to: '', body: '' } : v === 'prreview' ? { type: 'prreview' } : { type: 'spawn', prompt: '' } })} />
      </label>
      {a.type === 'prreview' ? <p role="note">{d.workspaceId ? T.prreviewHint : T.prreviewNeedsWorkspace}</p> : a.type === 'spawn' ? <label className={field}>{T.prompt}<Textarea value={a.prompt} onChange={(e) => set({ action: { type: 'spawn', prompt: e.target.value } })} /></label> : (
        <>
          <AgentPicker value={a.to} agents={(props.agents ?? []).filter((n) => !d.workspaceId || n.workspaceId === d.workspaceId)}
            onChange={(to) => set({ action: { ...a, to } })} />
          <label className={field}>{T.body}<Textarea value={a.body} onChange={(e) => set({ action: { ...a, body: e.target.value } })} /></label>
        </>
      )}
      <details open={props.initial.precheck !== null} data-testid="routine-more">
        <summary>{T.more}</summary>
        <div className="mt-1 flex flex-col gap-2">
          <div className={field}>
            <label className={field}>{T.precheck}<Input value={d.precheck?.command ?? ''} className="font-mono"
              onChange={(e) => set({ precheck: e.target.value ? { command: e.target.value, timeoutSeconds: d.precheck?.timeoutSeconds ?? 60 } : null })} /></label>
            <span className="opacity-70">{T.precheckHint}</span>
          </div>
          {d.precheck ? (
            <label className={field}>{T.precheckTimeout}
              <SettingsSelect value={String(d.precheck.timeoutSeconds)} options={numberOptions(TIMEOUT_CHOICES, d.precheck.timeoutSeconds, T.seconds)}
                onChange={(v) => d.precheck && set({ precheck: { ...d.precheck, timeoutSeconds: Number(v) } })} />
            </label>
          ) : null}
          {t.type === 'event' ? (
            <label className={field}>{T.debounce}
              <SettingsSelect value={String((t.debounceMs ?? 5000) / 1000)} options={numberOptions(DEBOUNCE_CHOICES, (t.debounceMs ?? 5000) / 1000, T.seconds)}
                onChange={(v) => set({ trigger: { ...t, debounceMs: Number(v) * 1000 } })} />
            </label>
          ) : null}
          <label className={field}>{T.maxRuns}
            <SettingsSelect value={String(d.budget.maxRunsPerDay)} options={numberOptions(MAX_RUNS_CHOICES, d.budget.maxRunsPerDay, T.runs)}
              onChange={(v) => set({ budget: { ...d.budget, maxRunsPerDay: Number(v) } })} />
          </label>
          <div className={field}>
            <label htmlFor="routine-max-cost">{T.maxCost}</label>
            <SettingsCombobox id="routine-max-cost" fieldId={ROUTINE_MAX_COST_FIELD_ID} presets={ROUTINE_MAX_COST_PRESETS} placeholder="No limit"
              value={d.budget.maxCostUsdPerDay == null ? '' : String(d.budget.maxCostUsdPerDay)} validate={validateDollars}
              onCommit={(v) => { const m = dollarsToMicros(v); set({ budget: { ...d.budget, maxCostUsdPerDay: m == null ? null : m / 1e6 } }) }} />
          </div>
        </div>
      </details>
      <label className="flex items-center gap-1"><SettingsCheckbox checked={d.enabled} onChange={(enabled) => set({ enabled })} />{T.enabled}</label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={d.name.trim() === '' || (a.type === 'prreview' && !d.workspaceId) || (a.type === 'outbox' && !a.to)}>{T.save}</Button>
        <Button size="sm" type="button" variant="secondary" onClick={props.onCancel}>{T.cancel}</Button>
      </div>
    </form>
  )
}

/** "Message a wired agent" target: a select of agent nodes (title · board), never a typed node id. */
function AgentPicker({ value, agents, onChange }: { value: string; agents: RoutineAgentNode[]; onChange(id: string): void }): React.JSX.Element {
  if (agents.length === 0 && !value) return <p role="note">{T.noAgents}</p>
  return (
    <label className={field}>{T.to}
      <SettingsSelect value={value} onChange={onChange}
        options={[{ value: '', label: T.pickAgent }, ...agents.map((n) => ({ value: n.id, label: `${n.title} · ${n.workspaceName}` }))]} />
    </label>
  )
}
