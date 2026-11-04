// Create/edit form for one routine (Settings › Control › Routines). Plain controlled fields mapped
// to the server's routine definition; the server validates (cron, patterns, ranges) and its error
// text is shown as-is.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'

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
  trigger: 'Trigger', schedule: 'Schedule (cron)', event: 'Event', api: 'API / manual only',
  cron: 'Cron (minute hour day month weekday), e.g. 0 9 * * 1', pattern: 'Event kind, e.g. hook.Stop or fs.*', debounce: 'Debounce (s)',
  precheck: 'Precheck command (exit 0 = run, otherwise skip; optional)', precheckTimeout: 'Timeout (s)',
  action: 'Action', spawn: 'Start a headless Claude agent', outbox: 'Message a wired agent', prreview: 'Review new pull requests',
  prreviewHint: 'Reviews open pull requests of the workspace folder whose head is new. Drafts land in the Inbox; nothing is posted to GitHub until you approve it.',
  prreviewNeedsWorkspace: 'Pick a workspace: its folder is the repo whose pull requests are reviewed.',
  prompt: 'Prompt', to: 'Agent node id', body: 'Message',
  maxRuns: 'Max runs / 24h', maxCost: 'Max cost USD / 24h (optional)', enabled: 'Enabled',
  save: 'Save', cancel: 'Cancel',
} as const

export const EMPTY_ROUTINE: RoutineDef = {
  name: '', enabled: true, workspaceId: null, trigger: { type: 'schedule', cron: '0 9 * * 1' }, precheck: null,
  action: { type: 'spawn', prompt: '' }, budget: { maxRunsPerDay: 24, maxCostUsdPerDay: null },
}

const T = ROUTINE_FORM_TEXT
const field = 'flex flex-col gap-1'

export function RoutinesForm(props: {
  initial: RoutineDef
  workspaces: { id: string; name: string }[]
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
      {t.type === 'schedule' ? <label className={field}>{T.cron}<Input value={t.cron} onChange={(e) => set({ trigger: { type: 'schedule', cron: e.target.value } })} /></label> : null}
      {t.type === 'event' ? (
        <div className="flex gap-2">
          <label className={`${field} flex-1`}>{T.pattern}<Input value={t.pattern} onChange={(e) => set({ trigger: { ...t, pattern: e.target.value } })} /></label>
          <label className={field}>{T.debounce}<Input type="number" min={0} value={(t.debounceMs ?? 5000) / 1000}
            onChange={(e) => set({ trigger: { ...t, debounceMs: Math.round(Number(e.target.value) * 1000) } })} /></label>
        </div>
      ) : null}
      <div className="flex gap-2">
        <label className={`${field} flex-1`}>{T.precheck}<Input value={d.precheck?.command ?? ''}
          onChange={(e) => set({ precheck: e.target.value ? { command: e.target.value, timeoutSeconds: d.precheck?.timeoutSeconds ?? 60 } : null })} /></label>
        <label className={field}>{T.precheckTimeout}<Input type="number" min={1} max={600} value={d.precheck?.timeoutSeconds ?? 60} disabled={!d.precheck}
          onChange={(e) => d.precheck && set({ precheck: { ...d.precheck, timeoutSeconds: Number(e.target.value) } })} /></label>
      </div>
      <label className={field}>{T.action}
        <SettingsSelect value={a.type} options={[{ value: 'spawn', label: T.spawn }, { value: 'outbox', label: T.outbox }, { value: 'prreview', label: T.prreview }]}
          onChange={(v) => set({ action: v === 'outbox' ? { type: 'outbox', to: '', body: '' } : v === 'prreview' ? { type: 'prreview' } : { type: 'spawn', prompt: '' } })} />
      </label>
      {a.type === 'prreview' ? <p role="note">{d.workspaceId ? T.prreviewHint : T.prreviewNeedsWorkspace}</p> : a.type === 'spawn' ? <label className={field}>{T.prompt}<Textarea value={a.prompt} onChange={(e) => set({ action: { type: 'spawn', prompt: e.target.value } })} /></label> : (
        <>
          <label className={field}>{T.to}<Input value={a.to} onChange={(e) => set({ action: { ...a, to: e.target.value } })} /></label>
          <label className={field}>{T.body}<Textarea value={a.body} onChange={(e) => set({ action: { ...a, body: e.target.value } })} /></label>
        </>
      )}
      <div className="flex gap-2">
        <label className={field}>{T.maxRuns}<Input type="number" min={1} value={d.budget.maxRunsPerDay}
          onChange={(e) => set({ budget: { ...d.budget, maxRunsPerDay: Number(e.target.value) } })} /></label>
        <label className={field}>{T.maxCost}<Input type="number" min={0} step="0.01" value={d.budget.maxCostUsdPerDay ?? ''}
          onChange={(e) => set({ budget: { ...d.budget, maxCostUsdPerDay: e.target.value === '' ? null : Number(e.target.value) } })} /></label>
      </div>
      <label className="flex items-center gap-1"><SettingsCheckbox checked={d.enabled} onChange={(enabled) => set({ enabled })} />{T.enabled}</label>
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={d.name.trim() === '' || (a.type === 'prreview' && !d.workspaceId)}>{T.save}</Button>
        <Button size="sm" type="button" variant="secondary" onClick={props.onCancel}>{T.cancel}</Button>
      </div>
    </form>
  )
}
