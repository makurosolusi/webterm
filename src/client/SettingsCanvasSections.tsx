// Settings › Canvas: the grid (one segmented choice: off / dots / dots + snap), quick move & resize, and where new
// projects go. Grid size and cables sit under Advanced. New nodes take the size of the last resize
// (App `resizedNodeSize`), so there is no node-size setting.
import { QUICK_DRAG_PRESETS, DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { Input } from '@/components/ui/input'
import { Field, SelectField, ToggleField } from './SettingsFields'
import { SettingsAdvanced, SettingsGroup, SettingsSegmented, type SegmentedOption } from './SettingsControls'
import { NumberSelectField } from './SettingsPickerFields'
import { EDGE_COLOR_PRESETS, EDGE_WIDTH_OPTIONS, GRID_SIZE_OPTIONS, MASK_AUTO_HIDE_OPTIONS } from './settingsPresets'
import { SkillCableFields } from './SettingsSkillCable'
import { Swatch } from './CanvasBackgroundControls'
import { EDGE_STROKE } from './canvasStyle'
import './canvasBackground.css'
import { quickDragLabel } from './quickDrag/quickDrag.modifier'
import { isMacPlatform } from './terminalKeys'
import { ProjectsFolderSetting } from './workspaceCreate/ProjectsFolderSetting'
import { COMMANDS_TEXT } from './customCommands/commands.labels'
import { CustomCommandsPanel } from './customCommands/CustomCommandsPanel'
import { useFieldSave } from './settingsSave'
import { settingsSaves } from './useSettings'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

type GridMode = 'off' | 'dots' | 'snap'
/** The one Grid choice over the two keys behind it (dots drawn, snapping on). Snap shows the dots it snaps to. */
export const gridMode = (s: Pick<Settings, 'canvasDots' | 'snapToGrid'>): GridMode => (s.snapToGrid ? 'snap' : s.canvasDots ? 'dots' : 'off')
export const gridPatch = (m: GridMode): Pick<Settings, 'canvasDots' | 'snapToGrid'> => ({ canvasDots: m !== 'off', snapToGrid: m === 'snap' })

const GRID_OPTIONS: readonly SegmentedOption<GridMode>[] = [
  { value: 'off', label: 'Off' }, { value: 'dots', label: 'Dots' }, { value: 'snap', label: 'Dots and snap' },
]

function GridField({ settings: s, onChange }: P): React.JSX.Element {
  const mode = gridMode(s)
  const save = useFieldSave(settingsSaves, 'canvasDots')
  return (
    <Field label="Grid" htmlFor="st-grid" field="canvasDots" save={save}
      hint="Snap rounds a dragged node’s position to the dots."
      modified={mode !== gridMode(DEFAULT_SETTINGS)} onReset={() => onChange(gridPatch(gridMode(DEFAULT_SETTINGS)))}>
      <SettingsSegmented<GridMode> id="st-grid" ariaLabel="Grid" value={mode} onChange={(m) => onChange(gridPatch(m))} options={GRID_OPTIONS} />
    </Field>
  )
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
      <SettingsGroup title="Nodes">
        <GridField settings={s} onChange={onChange} />
        <SelectField setting="quickDrag" id="st-quickDrag" label="Quick move & resize" value={s.quickDrag}
          hint="Hold the keys and drag anywhere on a node: the middle moves it, an edge or corner resizes it."
          options={QUICK_DRAG_PRESETS.map((p) => ({ value: p, label: quickDragLabel(p, isMacPlatform()) }))}
          onChange={(v) => onChange({ quickDrag: v })} />
        <ToggleField setting="nodeStatusBar" id="st-nodeStatusBar" label="Status bar" value={s.nodeStatusBar}
          hint="Show session and agent details at the bottom of each node, with warnings when something looks wrong."
          onChange={(v) => onChange({ nodeStatusBar: v })} />
      </SettingsGroup>
      <SettingsGroup title="File editor">
        <ToggleField setting="maskSecrets" id="st-maskSecrets" label="Mask secrets in files" value={s.maskSecrets}
          hint="Values of API keys, tokens and passwords are hidden until you reveal them."
          onChange={(v) => onChange({ maskSecrets: v })} />
        <NumberSelectField setting="maskAutoHideSec" id="st-maskAutoHideSec" label="Hide revealed secrets after" value={s.maskAutoHideSec}
          options={MASK_AUTO_HIDE_OPTIONS} onChange={(v) => onChange({ maskAutoHideSec: v })}
          lock={s.maskSecrets ? undefined : { reason: 'Turn on “Mask secrets in files” first.' }} />
      </SettingsGroup>
      <SettingsGroup title="New projects">
        <ProjectsFolderSetting value={s.defaultProjectsFolder} onChange={(v) => onChange({ defaultProjectsFolder: v })} />
      </SettingsGroup>
      <SettingsGroup title="Commands">
        <Field label={COMMANDS_TEXT.title} hint={COMMANDS_TEXT.intro} field="custom-commands" block>
          <CustomCommandsPanel />
        </Field>
      </SettingsGroup>
      <SettingsAdvanced>
        <NumberSelectField setting="gridSize" id="st-gridSize" label="Grid size" value={s.gridSize} options={GRID_SIZE_OPTIONS}
          onChange={(v) => onChange({ gridSize: v })} />
        <CableColorField value={s.edgeColor} onChange={(edgeColor) => onChange({ edgeColor })} />
        <NumberSelectField setting="edgeWidth" id="st-edgeWidth" label="Cable thickness" value={s.edgeWidth} options={EDGE_WIDTH_OPTIONS}
          onChange={(v) => onChange({ edgeWidth: v })} />
        <SkillCableFields settings={s} onChange={onChange} />
      </SettingsAdvanced>
    </>
  )
}
