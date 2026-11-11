// Section Canvas di Settings: grid, ukuran node baru, dan mesin pencari node browser.
import { QUICK_DRAG_PRESETS, type Settings } from '../shared/settings'
import { SEARCH_ENGINES, type SearchEngine } from '../shared/browser.omnibox'
import { Input } from '@/components/ui/input'
import { Field, SelectField, ToggleField } from './SettingsFields'
import { NumberSelectField } from './SettingsPickerFields'
import { EDGE_COLOR_PRESETS, EDGE_WIDTH_OPTIONS, GRID_SIZE_OPTIONS, NODE_HEIGHT_OPTIONS, NODE_WIDTH_OPTIONS } from './settingsPresets'
import { Swatch } from './CanvasBackgroundControls'
import { EDGE_STROKE } from './canvasStyle'
import './canvasBackground.css'
import { NotificationRows } from './osNotify.settings'
import { quickDragLabel } from './quickDrag/quickDrag.modifier'
import { isMacPlatform } from './terminalKeys'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

function CableColorField({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <Field label="Cable color" setting="edgeColor" hint="Color of the cables between nodes. Selected cables keep the highlight color." block>
      <div className="cbg-swatches">
        <Swatch label="Default" background={EDGE_STROKE} selected={value === 'default'} onClick={() => onChange('default')} />
        {EDGE_COLOR_PRESETS.map((p) => (
          <Swatch key={p.color} label={p.label} background={p.color} selected={value === p.color} onClick={() => onChange(p.color)} />
        ))}
        <label className="cbg-swatches">
          Custom
          <Input type="color" className="cbg-color" aria-label="Custom cable color"
            value={value === 'default' ? EDGE_COLOR_PRESETS[0].color : value} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </Field>
  )
}

export function CanvasSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <NumberSelectField setting="gridSize" id="st-gridSize" label="Grid size" value={s.gridSize} options={GRID_SIZE_OPTIONS}
        onChange={(v) => onChange({ gridSize: v })} />
      <ToggleField setting="snapToGrid" id="st-snapToGrid" label="Snap to grid" value={s.snapToGrid}
        hint="While on, dragging a node rounds its position to the grid." onChange={(v) => onChange({ snapToGrid: v })} />
      <SelectField setting="quickDrag" id="st-quickDrag" label="Quick move & resize" value={s.quickDrag}
        hint="Hold the keys and drag anywhere on a node: the middle moves it, an edge or corner resizes it. Right-drag resizes from the nearest corner."
        options={QUICK_DRAG_PRESETS.map((p) => ({ value: p, label: quickDragLabel(p, isMacPlatform()) }))}
        onChange={(v) => onChange({ quickDrag: v })} />
      <ToggleField setting="canvasDots" id="st-canvasDots" label="Grid dots" value={s.canvasDots}
        hint="Visual only — snapping is unchanged." onChange={(v) => onChange({ canvasDots: v })} />
      <CableColorField value={s.edgeColor} onChange={(edgeColor) => onChange({ edgeColor })} />
      <NumberSelectField setting="edgeWidth" id="st-edgeWidth" label="Cable thickness" value={s.edgeWidth} options={EDGE_WIDTH_OPTIONS}
        onChange={(v) => onChange({ edgeWidth: v })} />
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
