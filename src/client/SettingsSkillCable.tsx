// Settings › Canvas › Advanced: Skill cable color (named swatch radios from the workspace palette) and Skill cable size
// (four named widths), each with a small line preview. No typing; Reset comes from `Field` (`setting` + scope).
import { SKILL_CABLE_COLORS, SKILL_CABLE_SIZES, SKILL_CABLE_WIDTH_PX, type SkillCableSize } from '../shared/settings.skillCable'
import { workspaceHueLabel, type WorkspaceHue } from '../shared/workspaceColor'
import type { Settings } from '../shared/settings'
import { Field } from './SettingsFields'
import { SettingsSegmented, type SegmentedOption } from './SettingsControls'
import { skillCableColorCss } from './skillCable.style'

const COLOR_OPTIONS: readonly SegmentedOption<string>[] = SKILL_CABLE_COLORS.map((id) => ({
  value: id,
  label: id === 'default' ? 'Default (accent)' : workspaceHueLabel(id as WorkspaceHue),
  glyph: <span className="st-skill-cable-chip" style={{ background: skillCableColorCss(id) }} />,
}))

const SIZE_LABELS: Record<SkillCableSize, string> = { thin: 'Thin', normal: 'Normal', thick: 'Thick', xthick: 'Extra thick' }
const SIZE_OPTIONS: readonly SegmentedOption<SkillCableSize>[] = SKILL_CABLE_SIZES.map((id) => ({
  value: id, label: `${SIZE_LABELS[id]} ${SKILL_CABLE_WIDTH_PX[id]}px`,
}))

/** The dashed cable line as it will look: chosen color and width. */
export function SkillCablePreview({ color, size }: { color: string; size: SkillCableSize }): React.JSX.Element {
  return (
    <svg className="st-skill-cable-preview" width="120" height="12" role="img" aria-label="Skill cable preview">
      <line x1="2" y1="6" x2="118" y2="6" stroke={skillCableColorCss(color)} strokeWidth={SKILL_CABLE_WIDTH_PX[size]} strokeDasharray="3 4" strokeLinecap="round" />
    </svg>
  )
}

export function SkillCableFields({ settings: s, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }): React.JSX.Element {
  return (
    <>
      <Field label="Skill cable color" setting="skillCableColor" hint="Color of the cables that attach skills to agents. A skill that is unavailable keeps its warning color." block>
        <div className="st-skill-cable-colors">
          <SettingsSegmented<string> ariaLabel="Skill cable color" value={s.skillCableColor} options={COLOR_OPTIONS}
            onChange={(skillCableColor) => onChange({ skillCableColor })} />
          <SkillCablePreview color={s.skillCableColor} size={s.skillCableSize} />
        </div>
      </Field>
      <Field label="Skill cable size" setting="skillCableSize" hint="Line width of skill cables. Hovered and selected cables get a little thicker." block>
        <div className="st-skill-cable-colors">
          <SettingsSegmented<SkillCableSize> ariaLabel="Skill cable size" value={s.skillCableSize} options={SIZE_OPTIONS}
            onChange={(skillCableSize) => onChange({ skillCableSize })} />
          <SkillCablePreview color={s.skillCableColor} size={s.skillCableSize} />
        </div>
      </Field>
    </>
  )
}
