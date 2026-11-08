// Section Canvas di Settings: grid, ukuran node baru, dan mesin pencari node browser.
import type { Settings } from '../shared/settings'
import { SEARCH_ENGINES, type SearchEngine } from '../shared/browser.omnibox'
import { SelectField, ToggleField } from './SettingsFields'
import { NumberSelectField } from './SettingsPickerFields'
import { GRID_SIZE_OPTIONS, NODE_HEIGHT_OPTIONS, NODE_WIDTH_OPTIONS } from './settingsPresets'
import { NotificationRows } from './osNotify.settings'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function CanvasSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <NumberSelectField setting="gridSize" id="st-gridSize" label="Grid size" value={s.gridSize} options={GRID_SIZE_OPTIONS}
        onChange={(v) => onChange({ gridSize: v })} />
      <ToggleField setting="snapToGrid" id="st-snapToGrid" label="Snap to grid" value={s.snapToGrid}
        hint="While on, dragging a node rounds its position to the grid." onChange={(v) => onChange({ snapToGrid: v })} />
      <ToggleField setting="canvasDots" id="st-canvasDots" label="Grid dots" value={s.canvasDots}
        hint="Visual only — snapping is unchanged." onChange={(v) => onChange({ canvasDots: v })} />
      <NumberSelectField setting="defaultNodeWidth" id="st-nodeW" label="New node width" value={s.defaultNodeWidth} options={NODE_WIDTH_OPTIONS}
        hint="Existing nodes keep the size saved with them."
        onChange={(v) => onChange({ defaultNodeWidth: v })} />
      <NumberSelectField setting="defaultNodeHeight" id="st-nodeH" label="New node height" value={s.defaultNodeHeight} options={NODE_HEIGHT_OPTIONS}
        onChange={(v) => onChange({ defaultNodeHeight: v })} />
      <SelectField setting="browserSearchEngine" id="st-browserSearchEngine" label="Browser search engine" value={s.browserSearchEngine}
        hint="Used by browser nodes when what you type in the address bar is not a web address."
        options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((e) => ({ value: e, label: SEARCH_ENGINES[e].label }))}
        onChange={(v) => onChange({ browserSearchEngine: v })} />
      <NotificationRows />
    </>
  )
}
