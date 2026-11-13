// Settings › Central: the few real preferences, rendered from `CENTRAL_FIELDS` (centralSettings.registry.ts)
// as grouped cards (SettingsGroup, the last group folded under SettingsAdvanced); the rest is automatic (see
// the registry). Capabilities go through useCapabilities (server closes prerequisites and derives the
// agent/tool/planner keys); numbers through /api/settings/env; check-ins through their own endpoint.
import { ActionButton, useAction } from '@/components/ui/action'
import { Switch } from '@/components/ui/switch'
import type { Lock } from '@/components/ui/disabled-reason'
import { DEFAULT_CHECKIN_DAILY_LIMIT } from '../shared/centralWork'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { CAPABILITY_STATUS_LABEL } from './capabilitiesLabels'
import { useCheckinSettings, type CheckinApi } from './centralSettings.checkin'
import { LevelChoice, Stepper } from './centralSettings.controls'
import { useCentralEnv, type CentralEnv } from './centralSettings.env'
import { CENTRAL_FIELDS, CENTRAL_GROUPS, type CentralField, type CentralGroup, type CentralLinkTarget } from './centralSettings.registry'
import { CENTRAL_GROUP_TITLE, CENTRAL_TEXT } from './centralSettingsLabels'
import { SettingsAdvanced, SettingsGroup, SettingsSelect } from './SettingsControls'
import { CostLimitField } from './SettingsCostLimit'
import { Field, lockReasonId } from './SettingsFields'
import { SettingsMessage } from './SettingsMessage'
import { useCapabilities, type CapabilitiesApi } from './useCapabilities'

export interface CentralSettingsSectionProps {
  settings: Settings
  onChange(patch: SettingsPatch): void
  /** Opens another Settings section (links to Agent › Models, Control › Cost, the Browser card…). */
  onNavigate(to: CentralLinkTarget): void
}

const isOn = (v: CapabilityView | undefined): boolean => v?.status === 'on'

/** Segmented over capabilities: the last option whose capability is on ('none' when none is). */
export function levelOf(field: CentralField, view: (id: CapabilityId) => CapabilityView | undefined): string {
  const opts = field.options ?? []
  return [...opts].reverse().find((o) => o.value !== 'none' && isOn(view(o.value as CapabilityId)))?.value ?? 'none'
}

/** The one toggle that moves the level to `target`: turn off the first higher level that is on (its dependents follow), else turn the target on (its prerequisites follow). */
export function levelToggle(field: CentralField, target: string, view: (id: CapabilityId) => CapabilityView | undefined): { id: CapabilityId; on: boolean } | null {
  const opts = (field.options ?? []).map((o) => o.value)
  const t = opts.indexOf(target)
  const higher = opts.slice(t + 1).find((v) => isOn(view(v as CapabilityId)))
  if (higher) return { id: higher as CapabilityId, on: false }
  if (target === 'none' || isOn(view(target as CapabilityId))) return null
  return { id: target as CapabilityId, on: true }
}

/** Why a control is disabled, or null. */
function reasonOf(field: CentralField, api: CapabilitiesApi, env: CentralEnv, checkin: CheckinApi): string | null {
  const view = (id: CapabilityId): CapabilityView | undefined => api.data?.capabilities.find((v) => v.id === id)
  if (field.always) return null
  if (!api.data) return api.error ? CENTRAL_TEXT.unavailable : CENTRAL_TEXT.loading
  if (!isOn(view('central'))) return CENTRAL_TEXT.offReason
  if (field.needs && !isOn(view(field.needs))) return field.needs === 'autonomy' ? CENTRAL_TEXT.autonomyOffReason : CENTRAL_TEXT.workersOffReason
  const src = field.source
  if (src.kind === 'checkin' && !checkin.data) return checkin.error ? CENTRAL_TEXT.unavailable : CENTRAL_TEXT.loading
  if (src.kind === 'capability' && src.sub && !view(src.id)?.subs?.some((s) => s.key === src.sub)) return CENTRAL_TEXT.unavailable
  if (src.kind === 'env' && field.control !== 'combobox') {
    if (env.load.status === 'loading') return CENTRAL_TEXT.loading
    if (env.load.status === 'error') return CENTRAL_TEXT.unavailable
    const e = env.entry(src.key)
    if (!e) return CENTRAL_TEXT.unavailable
    if (!e.editable || env.load.locked) return CENTRAL_TEXT.locked
  }
  return null
}

/** Default of a check-in key (the Settings row it lives in), for the modified dot and Reset. */
const CHECKIN_DEFAULT = { enabled: DEFAULT_SETTINGS.centralCheckins, dailyLimit: DEFAULT_CHECKIN_DAILY_LIMIT } as const

export function CentralSettingsSection({ settings: s, onChange }: CentralSettingsSectionProps): React.JSX.Element {
  const api = useCapabilities()
  const env = useCentralEnv()
  const checkin = useCheckinSettings()
  const view = (id: CapabilityId): CapabilityView | undefined => api.data?.capabilities.find((v) => v.id === id)
  const central = view('central')
  // "Propose work" always asks before each worker runs: moving there also turns that approval on (the old
  // separate switch), so the ledger setting cannot drift from what the level promises.
  const moveLevel = async (v: string): Promise<void> => {
    const levelField = CENTRAL_FIELDS.find((x) => x.id === 'level')!
    const t = levelToggle(levelField, v, view)
    if (t && !(await api.toggle(t.id, t.on))) return
    if (v === 'workers') await api.setSub('workers', 'runRequireApproval', true)
  }
  // Busy only: the step disappears once Central is on, and a refusal is the alert at the top.
  const fixChain = useAction(() => api.toggle('central', true), { label: CENTRAL_TEXT.fixChain, toast: 'never' })

  // Each control gives its own feedback: capability rows disable while saving (a refusal is the notice at
  // the top); env, check-in and Settings rows show the row's save status.
  const control = (field: CentralField, id: string, disabled: boolean, why: string | undefined): React.ReactNode => {
    const src = field.source
    if (src.kind === 'capability') {
      if (field.control === 'segmented') {
        return (
          <LevelChoice id={id} label={field.label} value={levelOf(field, view)} options={field.options ?? []} describedBy={why}
            disabled={disabled || api.busyId !== null} onChange={(v) => { void moveLevel(v) }} />
        )
      }
      const sub = src.sub ? view(src.id)?.subs?.find((x) => x.key === src.sub) : undefined
      const status = view(src.id)?.status
      const checked = src.sub ? !!sub?.on : status !== undefined && status !== 'off'
      const saveCapability = (on: boolean): void => { void (src.sub ? api.setSub(src.id, src.sub, on) : api.toggle(src.id, on)) }
      return (
        <>
          {/* The switch already says on/off; only an in-between state ("Needs one step") gets words. */}
          {!src.sub && status === 'needs-step' ? <span role="status" className="st-hint">{CAPABILITY_STATUS_LABEL[status]}</span> : null}
          <Switch id={id} checked={checked} disabled={disabled || !api.data || api.busyId === src.id} aria-describedby={why}
            onCheckedChange={saveCapability} />
        </>
      )
    }
    if (src.kind === 'checkin') {
      const { data } = checkin
      const saveEnabled = (on: boolean): void => { void checkin.save({ enabled: on }) }
      if (field.control === 'switch') {
        return <Switch id={id} checked={data?.enabled ?? false} disabled={disabled || checkin.saving} aria-describedby={why} onCheckedChange={saveEnabled} />
      }
      const limit = String(data?.dailyLimit ?? DEFAULT_CHECKIN_DAILY_LIMIT)
      return (
        <>
          {data ? <span role="status" className="st-hint">{CENTRAL_TEXT.checkinUsed(data.usedToday, data.dailyLimit)}</span> : null}
          <SettingsSelect id={id} value={limit} disabled={disabled || checkin.saving} describedBy={why} options={field.options ?? []}
            onChange={(v) => void checkin.save({ dailyLimit: Number(v) })} />
        </>
      )
    }
    if (src.kind === 'setting') {
      return <Switch id={id} checked={s[src.key]} disabled={disabled} aria-describedby={why} onCheckedChange={(on) => onChange({ [src.key]: on })} />
    }
    if (src.kind !== 'env' || field.control !== 'stepper') return null // env rows are numbers; the limit is CostLimitField
    const raw = env.value(src.key)
    const scale = src.scale ?? 1
    return <Stepper id={id} label={field.label} value={Math.round((Number(raw) || 0) / scale)} min={field.min ?? 0}
      max={field.max ?? Number.MAX_SAFE_INTEGER} step={field.step ?? 1} unit={src.unit} disabled={disabled} describedBy={why}
      onChange={(v) => void env.write(src.key, String(v * scale))} />
  }

  /** modified + Reset + save status of a row, by where its value lives. */
  const state = (field: CentralField): { save?: ReturnType<CentralEnv['saveState']>; modified?: boolean; reset?: () => void; setting?: keyof Settings } => {
    const src = field.source
    if (src.kind === 'env') return { save: env.saveState(src.key), modified: env.modified(src.key), reset: () => { void env.write(src.key, null) } }
    if (src.kind === 'checkin') {
      const def = CHECKIN_DEFAULT[src.key]
      const modified = checkin.data !== null && checkin.data[src.key] !== def
      return { save: checkin.saveState(src.key), modified, reset: () => { void checkin.save({ [src.key]: def }) } }
    }
    if (src.kind === 'setting') return { setting: src.key }
    return {}
  }

  const row = (field: CentralField): React.ReactNode => {
    const reason = reasonOf(field, api, env, checkin)
    if (field.control === 'combobox') return <CostLimitField key={field.id} disabledReason={reason ?? undefined} />
    const id = `st-central-${field.id}`
    const lock: Lock | undefined = reason ? { reason } : undefined
    const st = state(field)
    return (
      <Field key={field.id} label={field.label} hint={field.hint} htmlFor={id} field={`central.${field.id}`} lock={lock}
        setting={st.setting} save={st.save} modified={st.modified} onReset={st.reset}>
        <span className="contents" data-central-field={field.id}>
          {control(field, id, reason !== null, reason ? lockReasonId(id) : undefined)}
        </span>
      </Field>
    )
  }

  const group = (g: CentralGroup): React.ReactNode => {
    const rows = CENTRAL_FIELDS.filter((x) => x.group === g).map(row)
    return g === 'advanced'
      ? <div key={g} data-central-group={g}><SettingsAdvanced>{rows}</SettingsAdvanced></div>
      : <div key={g} data-central-group={g}><SettingsGroup title={CENTRAL_GROUP_TITLE[g]}>{rows}</SettingsGroup></div>
  }

  return (
    <div className="st-central" data-section="central">
      {api.error ? <SettingsMessage kind="error" action={{ label: CENTRAL_TEXT.retry, run: () => { void api.refresh() } }}>{api.error}</SettingsMessage> : null}
      {api.data === null && api.error === null ? <SettingsMessage kind="loading">{CENTRAL_TEXT.loading}</SettingsMessage> : null}
      {env.load.status === 'error' ? (
        <SettingsMessage kind="error" action={{ label: CENTRAL_TEXT.retry, run: env.reload }}>{CENTRAL_TEXT.loadFailed(env.load.error)}</SettingsMessage>
      ) : null}
      {checkin.error && !checkin.data ? (
        <SettingsMessage kind="error" action={{ label: CENTRAL_TEXT.retry, run: checkin.reload }}>{CENTRAL_TEXT.checkinFailed}</SettingsMessage>
      ) : null}
      {central?.status === 'needs-step' && central.step?.kind === 'fixChain' ? (
        <SettingsMessage kind="warning">
          {central.detail ?? CAPABILITY_STATUS_LABEL['needs-step']}{' '}
          <ActionButton size="xs" variant="secondary" action={fixChain} busyLabel={CENTRAL_TEXT.fixing}>{central.step.label}</ActionButton>
        </SettingsMessage>
      ) : null}
      {CENTRAL_GROUPS.map(group)}
    </div>
  )
}
