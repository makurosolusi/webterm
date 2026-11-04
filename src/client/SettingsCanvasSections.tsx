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
      <NumberField setting="gridSize" id="st-gridSize" label="Ukuran grid" value={s.gridSize} min={4} max={200} unit="px"
        onChange={(v) => onChange({ gridSize: v })} />
      <ToggleField setting="snapToGrid" id="st-snapToGrid" label="Snap ke grid" value={s.snapToGrid}
        hint="Selagi on, menggeser node membulatkan posisinya ke grid." onChange={(v) => onChange({ snapToGrid: v })} />
      <ToggleField setting="canvasDots" id="st-canvasDots" label="Titik grid" value={s.canvasDots}
        hint="Tampilan saja — snapping tidak berubah." onChange={(v) => onChange({ canvasDots: v })} />
      <NumberField setting="defaultNodeWidth" id="st-nodeW" label="Lebar node baru" value={s.defaultNodeWidth} min={200} max={4000} step={20} unit="px"
        hint="Node yang sudah ada tetap memakai ukuran yang tersimpan bersamanya."
        onChange={(v) => onChange({ defaultNodeWidth: v })} />
      <NumberField setting="defaultNodeHeight" id="st-nodeH" label="Tinggi node baru" value={s.defaultNodeHeight} min={120} max={4000} step={20} unit="px"
        onChange={(v) => onChange({ defaultNodeHeight: v })} />
      <SelectField setting="browserSearchEngine" id="st-browserSearchEngine" label="Mesin pencari browser" value={s.browserSearchEngine}
        hint="Dipakai node browser saat ketikan di bilah alamat bukan alamat web."
        options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((e) => ({ value: e, label: SEARCH_ENGINES[e].label }))}
        onChange={(v) => onChange({ browserSearchEngine: v })} />
      <NotificationRows />
    </>
  )
}
