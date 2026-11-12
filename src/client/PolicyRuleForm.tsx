// Settings › Rules & secrets › Advanced: make any rule from raw patterns (Who select, What/Where comboboxes with
// plain-word presets, Effect, How long). Most rules come from "Always allow / block" on recent approvals instead.
import { useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Segmented } from './centralSettings.controls'
import { SettingsSelect } from './SettingsControls'
import { SettingsCombobox } from './SettingsCombobox'
import { createRule, type PolicyGrant } from './policyRules.api'
import { CAPABILITY_PRESETS, SCOPE_PRESETS, SUBJECTS } from './policyPresets'

const HOUR_MS = 3_600_000

export const RULE_FORM_TEXT = {
  title: 'Make a rule by hand',
  subject: 'Who', capability: 'What', scope: 'Where',
  effect: 'Effect', duration: 'How long', add: 'Add rule', adding: 'Adding…', added: 'Rule added',
  needWhat: 'Pick or type what the rule covers first.',
} as const
const T = RULE_FORM_TEXT

const DURATIONS = [
  { value: '1h', label: '1 hour', ms: HOUR_MS },
  { value: '1d', label: '1 day', ms: 24 * HOUR_MS },
  { value: 'forever', label: 'Forever', ms: null },
] as const
const EFFECTS = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }] as const

export function PolicyRuleForm({ now = Date.now }: { now?: () => number }): React.JSX.Element {
  const [form, setForm] = useState({ subject: 'node:*', capability: '', scope: '*', effect: 'allow' as PolicyGrant['effect'], duration: '1h' })
  const add = useAction(async () => {
    const ms = (DURATIONS.find((d) => d.value === form.duration) ?? DURATIONS[0]).ms // null = Forever
    await createRule({ subject: form.subject.trim(), capability: form.capability.trim(), scope: form.scope.trim() || '*', effect: form.effect, ...(ms === null ? {} : { expiresAt: now() + ms }) })
  }, { label: T.add, success: () => T.added })

  const combo = (key: 'capability' | 'scope', presets: typeof CAPABILITY_PRESETS) => (
    <span className="w-56">
      <SettingsCombobox ariaLabel={T[key]} fieldId={`policy.${key}`} mono presets={presets} placeholder={T[key]}
        value={form[key]} onDraft={(v) => setForm((f) => ({ ...f, [key]: v }))} onCommit={(v) => setForm((f) => ({ ...f, [key]: v }))} />
    </span>
  )

  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="policy-add-rule">
      <h4 className="font-semibold">{T.title}</h4>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsSelect ariaLabel={T.subject} value={form.subject} options={SUBJECTS} onChange={(v) => setForm((f) => ({ ...f, subject: v }))} />
        {combo('capability', CAPABILITY_PRESETS)}{combo('scope', SCOPE_PRESETS)}
        <Segmented label={T.effect} value={form.effect} options={EFFECTS} onChange={(v) => setForm((f) => ({ ...f, effect: v as PolicyGrant['effect'] }))} />
        <Segmented label={T.duration} value={form.duration} options={DURATIONS} onChange={(v) => setForm((f) => ({ ...f, duration: v }))} />
        <ActionButton size="sm" action={add} busyLabel={T.adding} lock={form.capability.trim() === '' ? { reason: T.needWhat } : undefined}>{T.add}</ActionButton>
      </div>
      <ActionResult action={add} />
    </div>
  )
}
