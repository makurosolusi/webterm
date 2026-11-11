// Settings › Central Agent: every Central setting in one section, rendered from `CENTRAL_FIELDS`
// (centralSettings.registry.ts). Capabilities go through useCapabilities (server closes prerequisites
// and derives the agent/tool/planner keys); numbers and model through /api/settings/env.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { DEFAULT_CLAUDE_PROFILE, claudeProfiles } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { AgentEngineField } from './AgentEngineField'
import { CAPABILITY_STATUS_LABEL } from './capabilitiesLabels'
import { PROFILES_TEXT } from './claudeLauncher/ClaudeLaunchProfilesCard'
import { useCheckinSettings, type CheckinApi } from './centralSettings.checkin'
import { Segmented, Stepper } from './centralSettings.controls'
import { useCentralEnv, type CentralEnv } from './centralSettings.env'
import { CENTRAL_FIELDS, CENTRAL_GROUPS, type CentralField, type CentralGroup, type CentralLinkTarget } from './centralSettings.registry'
import { CENTRAL_GROUP_TITLE, CENTRAL_TEXT } from './centralSettingsLabels'
import { SettingsSelect } from './SettingsControls'
import { CostLimitField } from './SettingsCostLimit'
import { Field, matchesSearch, useSettingsSearch } from './SettingsFields'
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

export function CentralSettingsSection({ settings: s, onChange, onNavigate }: CentralSettingsSectionProps): React.JSX.Element {
  const api = useCapabilities()
  const env = useCentralEnv()
  const checkin = useCheckinSettings()
  const query = useSettingsSearch()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const view = (id: CapabilityId): CapabilityView | undefined => api.data?.capabilities.find((v) => v.id === id)
  const central = view('central')

  // The engine row is AgentEngineField itself (it has its own label, status and Check again).
  const engine = (): React.ReactNode => {
    if (!api.data) return null
    return (
      <div key="engine" className="px-3.5" data-central-field="engine" data-field="central.engine">
        <AgentEngineField redetect={api.recheck} />
      </div>
    )
  }

  const control = (field: CentralField, id: string, reason: string | null): React.ReactNode => {
    const src = field.source
    const disabled = reason !== null
    if (field.control === 'link' && src.kind === 'link') {
      return <Button size="xs" variant="link" className="px-0" aria-label={`${CENTRAL_TEXT.open} ${field.label}`} onClick={() => onNavigate(src.to)}>{CENTRAL_TEXT.open} →</Button>
    }
    if (field.control === 'combobox') return null // CostLimitField renders its own Field
    if (src.kind === 'capability') {
      if (field.control === 'status') return <span role="status" className="st-hint">{statusLine(field, view)}</span>
      if (field.control === 'segmented') {
        return (
          <Segmented label={field.label} value={levelOf(field, view)} options={field.options ?? []} disabled={disabled || api.busyId !== null}
            onChange={(v) => { const t = levelToggle(field, v, view); if (t) void api.toggle(t.id, t.on) }} />
        )
      }
      const sub = src.sub ? view(src.id)?.subs?.find((x) => x.key === src.sub) : undefined
      const checked = src.sub ? !!sub?.on : view(src.id)?.status !== undefined && view(src.id)?.status !== 'off'
      return (
        <span className="inline-flex items-center gap-2">
          {src.sub ? null : <span role="status" className="text-xs opacity-70">{CAPABILITY_STATUS_LABEL[view(src.id)?.status ?? 'off']}</span>}
          <Switch id={id} checked={checked} disabled={disabled || !api.data || api.busyId === src.id}
            onCheckedChange={(on) => void (src.sub ? api.setSub(src.id, src.sub, on) : api.toggle(src.id, on))} />
        </span>
      )
    }
    if (src.kind === 'setting') {
      const all = claudeProfiles(s)
      const current = all.some((p) => p.id === s.centralClaudeProfileId) ? s.centralClaudeProfileId : ''
      const options = [{ value: '', label: PROFILES_TEXT.sameAsDefault },
        ...all.map((p) => ({ value: p.id, label: p.id === DEFAULT_CLAUDE_PROFILE.id ? `${p.name} (claude)` : p.name }))]
      return <SettingsSelect id={id} value={current} options={options} disabled={disabled} onChange={(v) => onChange({ [src.key]: v })} />
    }
    if (src.kind === 'checkin') {
      const { data } = checkin
      if (field.control === 'switch') return <Switch id={id} checked={data?.enabled ?? false} disabled={disabled || checkin.saving} onCheckedChange={(on) => void checkin.save({ enabled: on })} />
      if (!data) return null
      const limit = String(data.dailyLimit)
      const opts = field.options ?? []
      return (
        <>
          <SettingsSelect id={id} value={limit} disabled={disabled || checkin.saving} onChange={(v) => void checkin.save({ dailyLimit: Number(v) })}
            options={opts.some((o) => o.value === limit) ? opts : [...opts, { value: limit, label: limit }]} />
          <span role="status" className="st-hint">{CENTRAL_TEXT.checkinUsed(data.usedToday, data.dailyLimit)}</span>
        </>
      )
    }
    if (src.kind !== 'env') return null
    const raw = env.value(src.key)
    if (field.control === 'switch') {
      return <Switch id={id} checked={raw.trim().toLowerCase() === 'on'} disabled={disabled} onCheckedChange={(on) => void env.write(src.key, on ? 'on' : 'off')} />
    }
    if (field.control === 'stepper') {
      const scale = src.scale ?? 1
      const n = Math.round((Number(raw) || 0) / scale)
      return <Stepper id={id} label={field.label} value={n} min={field.min ?? 0} max={field.max ?? Number.MAX_SAFE_INTEGER} step={field.step ?? 1}
        unit={src.unit} disabled={disabled} onChange={(v) => void env.write(src.key, String(v * scale))} />
    }
    const opts = field.options ?? []
    const known = opts.some((o) => o.value === raw)
    return (
      <SettingsSelect id={id} value={raw} disabled={disabled} onChange={(v) => void env.write(src.key, v === '' ? null : v)}
        options={known ? opts : [...opts, { value: raw, label: raw }]} />
    )
  }

  const row = (field: CentralField): React.ReactNode => {
    if (field.control === 'combobox') return <CostLimitField key={field.id} disabledReason={reasonOf(field, api, env, checkin) ?? undefined} />
    if (field.id === 'engine') return matches(field) ? engine() : null
    const id = `st-central-${field.id}`
    const reason = reasonOf(field, api, env, checkin)
    const src = field.source
    // Env rows: modified = an override that differs from the registry default; Reset removes it.
    const envKey = src.kind === 'env' ? src.key : null
    const save = envKey ? env.saveState(envKey) : src.kind === 'checkin' ? checkin.saveState(src.key) : undefined
    return (
      <Field key={field.id} label={field.label} hint={field.hint} htmlFor={id} setting={src.kind === 'setting' ? src.key : undefined} field={`central.${field.id}`}
        save={save} modified={envKey ? env.modified(envKey) : undefined}
        onReset={envKey && reason === null ? () => { void env.write(envKey, null) } : undefined}>
        <div className="flex flex-wrap items-center gap-2" data-central-field={field.id}>
          {control(field, id, reason)}
          {reason && field.control !== 'status' ? <span className="st-hint" data-reason>{reason}</span> : null}
          {field.control === 'status' && src.kind === 'capability' && src.id !== 'central'
            ? <Button size="xs" variant="link" className="px-0" aria-label={`${CENTRAL_TEXT.open} ${field.label}`}
                onClick={() => onNavigate({ section: 'capabilities', field: `capability.${src.id}` })}>{CENTRAL_TEXT.open} →</Button>
            : null}
        </div>
      </Field>
    )
  }

  const matches = (field: CentralField): boolean => matchesSearch(`${field.label} ${field.hint}`, query)
  const group = (g: CentralGroup): React.ReactNode => {
    const fields = CENTRAL_FIELDS.filter((x) => x.group === g)
    if (!fields.some(matches)) return null
    const plain = fields.filter((x) => !x.experiment)
    const experiments = fields.filter((x) => x.experiment)
    const body = (
      <>
        {plain.map(row)}
        {experiments.some(matches) ? <h5 className="st-group-title text-[13px]">{CENTRAL_TEXT.experiments}</h5> : null}
        {experiments.map(row)}
      </>
    )
    return g === 'advanced' ? (
      <details key={g} data-central-group={g} className="st-capabilities-advanced" open={advancedOpen || query !== ''}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary className="px-3.5">{CENTRAL_GROUP_TITLE[g]}</summary>
        {body}
      </details>
    ) : (
      <section key={g} data-central-group={g} aria-label={CENTRAL_GROUP_TITLE[g]}>
        <h4 className="st-group-title">{CENTRAL_GROUP_TITLE[g]}</h4>
        {body}
      </section>
    )
  }

  return (
    <div className="st-central" data-section="central">
      {api.error ? <p role="alert" className="st-hint">{api.error}</p> : null}
      {api.data === null && api.error === null ? <p role="status" className="st-hint">{CENTRAL_TEXT.loading}</p> : null}
      {env.load.status === 'error' ? (
        <p role="alert" className="st-hint">
          {CENTRAL_TEXT.loadFailed(env.load.error)} <Button size="xs" variant="secondary" onClick={env.reload}>{CENTRAL_TEXT.retry}</Button>
        </p>
      ) : null}
      {checkin.error && !checkin.data ? (
        <p role="alert" className="st-hint">
          {CENTRAL_TEXT.checkinFailed} <Button size="xs" variant="secondary" onClick={checkin.reload}>{CENTRAL_TEXT.retry}</Button>
        </p>
      ) : null}
      {central?.status === 'needs-step' && central.step?.kind === 'fixChain' ? (
        <Button size="sm" variant="secondary" onClick={() => void api.toggle('central', true)}>{central.step.label}</Button>
      ) : null}
      {CENTRAL_GROUPS.map(group)}
    </div>
  )
}

/** Read-only line for the Browser and Telegram rows. */
function statusLine(field: CentralField, view: (id: CapabilityId) => CapabilityView | undefined): string {
  const src = field.source
  if (src.kind !== 'capability') return ''
  const v = view(src.id)
  if (src.id === 'telegram') return v?.status === 'on' ? (v.detail ?? CENTRAL_TEXT.telegramOn) : v?.status === 'needs-step' ? CENTRAL_TEXT.telegramStep : CENTRAL_TEXT.telegramOff
  if (!isOn(v)) return CENTRAL_TEXT.browserOff
  return v?.subs?.find((x) => x.key === src.sub)?.on ? CENTRAL_TEXT.browserAgentsOn : CENTRAL_TEXT.browserAgentsOff
}
