// Section Canvas di Settings: grid, ukuran node baru, dan mesin pencari node browser.
import type { Settings } from '../shared/settings'
import { SEARCH_ENGINES, type SearchEngine } from '../shared/browser.omnibox'
import { NumberField, SelectField, ToggleField } from './SettingsFields'
import { NotificationRows } from './osNotify.settings'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function CanvasSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <NumberField setting="gridSize" id="st-gridSize" label="Grid size" value={s.gridSize} min={4} max={200} unit="px"
        onChange={(v) => onChange({ gridSize: v })} />
      <ToggleField setting="snapToGrid" id="st-snapToGrid" label="Snap to grid" value={s.snapToGrid}
        hint="While on, dragging a node rounds its position to the grid." onChange={(v) => onChange({ snapToGrid: v })} />
      <ToggleField setting="canvasDots" id="st-canvasDots" label="Grid dots" value={s.canvasDots}
        hint="Visual only — snapping is unchanged." onChange={(v) => onChange({ canvasDots: v })} />
      <NumberField setting="defaultNodeWidth" id="st-nodeW" label="New node width" value={s.defaultNodeWidth} min={200} max={4000} step={20} unit="px"
        hint="Existing nodes keep the size saved with them."
        onChange={(v) => onChange({ defaultNodeWidth: v })} />
      <NumberField setting="defaultNodeHeight" id="st-nodeH" label="New node height" value={s.defaultNodeHeight} min={120} max={4000} step={20} unit="px"
        onChange={(v) => onChange({ defaultNodeHeight: v })} />
      <SelectField setting="browserSearchEngine" id="st-browserSearchEngine" label="Browser search engine" value={s.browserSearchEngine}
        hint="Used by browser nodes when what you type in the address bar is not a web address."
        options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((e) => ({ value: e, label: SEARCH_ENGINES[e].label }))}
        onChange={(v) => onChange({ browserSearchEngine: v })} />
      <NotificationRows />
    </>
  )
}
