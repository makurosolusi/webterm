// Color choice of a browser profile: the workspace palette (12 named hues x 3 shades) as two radio rows, no hex typing.
// `hue`/`shade` undefined = "not chosen yet" (a new profile then gets a random unused hue from the server).
import { WORKSPACE_HUES, WORKSPACE_SHADES, DEFAULT_WORKSPACE_SHADE, isWorkspaceHue, isWorkspaceShade, workspaceColorVar, workspaceHueLabel } from '../shared/workspaceColor'
import { Button } from '@/components/ui/button'
import { RadioRow } from './WorkspaceColorPicker'
import { PROFILE_TEXT as T } from './browserProfile.text'

export interface ProfileColorValue { color?: string; shade?: string }

/** Hue + shade radio rows and a Random button; every pick reports the whole value. */
export default function ProfileColorPicker({ value, onChange }: { value: ProfileColorValue; onChange: (v: ProfileColorValue) => void }): React.JSX.Element {
  const hue = isWorkspaceHue(value.color) ? value.color : undefined
  const shade = isWorkspaceShade(value.shade) ? value.shade : DEFAULT_WORKSPACE_SHADE
  const swatchHue = hue ?? 'slate'
  return (
    <div className="flex flex-col" data-profile-color>
      <RadioRow
        label={T.hueLabel} value={hue ?? ''}
        items={WORKSPACE_HUES.map((h) => ({ id: h, label: workspaceHueLabel(h), swatch: workspaceColorVar(h, shade) }))}
        onPick={(color) => onChange({ color, shade })}
      />
      <RadioRow
        label={T.shadeLabel} value={shade}
        items={WORKSPACE_SHADES.map((s) => ({ id: s, label: s[0].toUpperCase() + s.slice(1), swatch: workspaceColorVar(swatchHue, s) }))}
        onPick={(s) => onChange({ color: hue ?? swatchHue, shade: s })}
      />
      <div>
        <Button type="button" size="bui" variant="outline" onClick={() => onChange({ color: WORKSPACE_HUES[Math.floor(Math.random() * WORKSPACE_HUES.length)], shade })}>{T.random}</Button>
      </div>
    </div>
  )
}
