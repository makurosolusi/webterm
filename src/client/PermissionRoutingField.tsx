// Settings › Claude › Permissions: who answers an agent's permission prompt first (docs/decisions/central-approver.md).
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import type { PermissionRouting } from '../shared/settings.permissionRouting'
import { SegmentedField } from './SettingsFields'

export const ROUTING_TEXT = {
  label: 'Who answers agent permission prompts',
  hint: 'Central decides routine requests and passes anything risky to you. Choose Me to see every request yourself.',
  options: [
    { value: 'central', label: 'Central first' },
    { value: 'human', label: 'Me' },
  ] as const satisfies readonly { value: PermissionRouting; label: string }[],
} as const

export function PermissionRoutingField({ settings: s, onChange }: { settings: Settings; onChange(patch: SettingsPatch): void }): React.JSX.Element {
  return (
    <SegmentedField id="st-permissionRouting" setting="permissionRouting" label={ROUTING_TEXT.label} hint={ROUTING_TEXT.hint}
      value={s.permissionRouting} options={ROUTING_TEXT.options} onChange={(v) => onChange({ permissionRouting: v })} />
  )
}
