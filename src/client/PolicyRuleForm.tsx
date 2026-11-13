// Settings › Rules & secrets › Add a rule: one row per choice, picked rather than typed: Who (select), What and
// Where (comboboxes with plain-word presets; a custom pattern is still possible), Effect and How long (segmented).
// Most rules come from "Always allow / block" on recent approvals instead.
import { useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { SettingsGroup, SettingsSegmented, SettingsSelect } from './SettingsControls'
import { SettingsCombobox } from './SettingsCombobox'
import { Field } from './SettingsFields'
import { createRule, type PolicyGrant } from './policyRules.api'
import { CAPABILITY_PRESETS, RULE_EFFECTS, SCOPE_PRESETS, SUBJECTS } from './policyPresets'

const HOUR_MS = 3_600_000

/** id of the What box: the empty rule list's "Add a rule" focuses it. */
export const RULE_FORM_WHAT_ID = 'policy-rule-what'

export const RULE_FORM_TEXT = {
  title: 'Add a rule',
  intro: 'Pick who, what and where. The rule starts working at once.',
  subject: 'Who', capability: 'What', scope: 'Where',
  subjectHint: 'Which agents the rule is for.',
  capabilityHint: 'The action. Pick one, or type a pattern.',
  scopeHint: 'Limit it to some commands, or leave it at Anywhere.',
  effect: 'Effect', duration: 'How long', add: 'Add rule', adding: 'Adding…', added: 'Rule added',
  needWhat: 'Pick what the rule covers first.',
} as const
const T = RULE_FORM_TEXT

const DURATIONS = [
  { value: '1h', label: '1 hour', ms: HOUR_MS },
  { value: '1d', label: '1 day', ms: 24 * HOUR_MS },
  { value: 'forever', label: 'Forever', ms: null },
] as const
type Duration = (typeof DURATIONS)[number]['value']

const IDS = { subject: 'policy-rule-who', capability: RULE_FORM_WHAT_ID, scope: 'policy-rule-where', effect: 'policy-rule-effect', duration: 'policy-rule-duration' } as const

export function PolicyRuleForm({ now = Date.now }: { now?: () => number }): React.JSX.Element {
  const [form, setForm] = useState({ subject: 'node:*', capability: '', scope: '*', effect: 'allow' as PolicyGrant['effect'], duration: '1h' as Duration })
  const add = useAction(async () => {
    const ms = (DURATIONS.find((d) => d.value === form.duration) ?? DURATIONS[0]).ms // null = Forever
    await createRule({ subject: form.subject.trim(), capability: form.capability.trim(), scope: form.scope.trim() || '*', effect: form.effect, ...(ms === null ? {} : { expiresAt: now() + ms }) })
  }, { label: T.add, success: () => T.added })

  const combo = (key: 'capability' | 'scope', presets: typeof CAPABILITY_PRESETS) => (
    <SettingsCombobox id={IDS[key]} ariaLabel={T[key]} fieldId={`policy.${key}`} presets={presets} placeholder={T[key]}
      value={form[key]} onDraft={(v) => setForm((f) => ({ ...f, [key]: v }))} onCommit={(v) => setForm((f) => ({ ...f, [key]: v }))} />
  )

  return (
    <div data-testid="policy-add-rule" className="contents">
      <SettingsGroup title={T.title} description={T.intro}>
        <Field label={T.subject} hint={T.subjectHint} htmlFor={IDS.subject}>
          <SettingsSelect id={IDS.subject} ariaLabel={T.subject} value={form.subject} options={SUBJECTS} onChange={(v) => setForm((f) => ({ ...f, subject: v }))} />
        </Field>
        <Field label={T.capability} hint={T.capabilityHint} htmlFor={IDS.capability}>{combo('capability', CAPABILITY_PRESETS)}</Field>
        <Field label={T.scope} hint={T.scopeHint} htmlFor={IDS.scope}>{combo('scope', SCOPE_PRESETS)}</Field>
        <Field label={T.effect} htmlFor={IDS.effect}>
          <SettingsSegmented id={IDS.effect} ariaLabel={T.effect} value={form.effect} options={RULE_EFFECTS} onChange={(v) => setForm((f) => ({ ...f, effect: v }))} />
        </Field>
        <Field label={T.duration} htmlFor={IDS.duration}>
          <SettingsSegmented id={IDS.duration} ariaLabel={T.duration} value={form.duration} options={DURATIONS} onChange={(v) => setForm((f) => ({ ...f, duration: v }))} />
        </Field>
        <div className="st-form">
          <ActionButton size="sm" action={add} busyLabel={T.adding} lock={form.capability.trim() === '' ? { reason: T.needWhat } : undefined}>{T.add}</ActionButton>
          <ActionResult action={add} />
        </div>
      </SettingsGroup>
    </div>
  )
}
