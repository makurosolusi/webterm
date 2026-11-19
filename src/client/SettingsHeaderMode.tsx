// Settings › Appearance › Header: Tabs / Hidden as a segmented control (no typing). The mode is
// a per-device preference kept in this browser (`headerMode.store`), so the row says "Saved on this browser".
import { SettingsCheckbox, SettingsGroup, SettingsSegmented, type SegmentedOption } from './SettingsControls'
import { Field } from './SettingsFieldRow'
import { useLocalFieldSave } from './settingsSave'
import { setRailLabels, useRailLabels } from './railLabels.store'
import { DEFAULT_HEADER_MODE, setHeaderMode, useHeaderMode, type HeaderMode } from './headerMode.store'

export const HEADER_MODE_FIELD = {
  label: 'Header',
  hint: 'Tabs shows the row of workspace tabs above the board. Hidden removes it and shows it when you push the pointer to the top edge. The menu and search are always in the left rail. Saved on this device.',
} as const

export const RAIL_LABELS_FIELD = {
  label: 'Show rail labels',
  hint: 'Pins the left rail open at 220px with a name beside every icon. Saved on this device.',
} as const

const HEADER_OPTIONS: readonly SegmentedOption<HeaderMode>[] = [
  { value: 'tabs', label: 'Tabs' }, { value: 'hidden', label: 'Hidden' },
]

export function HeaderModeField(): React.JSX.Element {
  const mode = useHeaderMode()
  const labels = useRailLabels()
  const [saveLabels, markLabels] = useLocalFieldSave()
  const [save, mark] = useLocalFieldSave()
  const choose = (m: HeaderMode): void => { setHeaderMode(m); mark() }
  return (
    <SettingsGroup title="Layout">
      <Field label={HEADER_MODE_FIELD.label} hint={HEADER_MODE_FIELD.hint} htmlFor="st-headerMode" field="header-mode" save={save}
        modified={mode !== DEFAULT_HEADER_MODE} onReset={() => choose(DEFAULT_HEADER_MODE)}>
        <SettingsSegmented<HeaderMode> id="st-headerMode" ariaLabel={HEADER_MODE_FIELD.label} value={mode} onChange={choose} options={HEADER_OPTIONS} />
      </Field>
      <Field label={RAIL_LABELS_FIELD.label} hint={RAIL_LABELS_FIELD.hint} htmlFor="st-railLabels" field="rail-labels" save={saveLabels}
        modified={labels} onReset={() => { setRailLabels(false); markLabels() }}>
        <SettingsCheckbox id="st-railLabels" ariaLabel={RAIL_LABELS_FIELD.label} checked={labels} onChange={(on) => { setRailLabels(on); markLabels() }} />
      </Field>
    </SettingsGroup>
  )
}
