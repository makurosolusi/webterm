// Settings › Appearance › Header: Full / Compact / Hidden as a segmented control (no typing). The mode is
// a per-device preference kept in this browser (`headerMode.store`), so the row says "Saved on this browser".
import { SettingsGroup, SettingsSegmented, type SegmentedOption } from './SettingsControls'
import { Field } from './SettingsFieldRow'
import { useLocalFieldSave } from './settingsSave'
import { DEFAULT_HEADER_MODE, setHeaderMode, useHeaderMode, type HeaderMode } from './headerMode.store'

export const HEADER_MODE_FIELD = {
  label: 'Header',
  hint: 'Full shows the title bar and the workspace tabs, Compact keeps one row, Hidden shows the header when you push the pointer to the top edge. Saved on this device.',
} as const

const HEADER_OPTIONS: readonly SegmentedOption<HeaderMode>[] = [
  { value: 'full', label: 'Full' }, { value: 'compact', label: 'Compact' }, { value: 'hidden', label: 'Hidden' },
]

export function HeaderModeField(): React.JSX.Element {
  const mode = useHeaderMode()
  const [save, mark] = useLocalFieldSave()
  const choose = (m: HeaderMode): void => { setHeaderMode(m); mark() }
  return (
    <SettingsGroup title="Layout">
      <Field label={HEADER_MODE_FIELD.label} hint={HEADER_MODE_FIELD.hint} htmlFor="st-headerMode" field="header-mode" save={save}
        modified={mode !== DEFAULT_HEADER_MODE} onReset={() => choose(DEFAULT_HEADER_MODE)}>
        <SettingsSegmented<HeaderMode> id="st-headerMode" ariaLabel={HEADER_MODE_FIELD.label} value={mode} onChange={choose} options={HEADER_OPTIONS} />
      </Field>
    </SettingsGroup>
  )
}
