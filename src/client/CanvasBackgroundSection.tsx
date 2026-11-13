// Canvas background in Settings › Appearance: edits the wallpaper of all workspaces; with a workspace
// open, ONE choice "This workspace: Same as all workspaces / Custom" decides whether the controls edit
// the shared wallpaper or this workspace's own. Changes apply live (canvas + preview box). Back to the
// default is the "Background style" row's own Reset (one place, like every other row).
import { useState } from 'react'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { CANVAS_BG_MODES, DEFAULT_CANVAS_BACKGROUND, type CanvasBackground, type CanvasBackgroundMode } from '../shared/canvasBackground.schema'
import { removeCanvasImage, uploadCanvasImage } from './canvasBackground.api'
import { needsContrastWarning } from './canvasBackground.style'
import { CanvasBackgroundLayer, useWallpaper } from './CanvasBackgroundLayer'
import { ColorControls, GradientControls, ImageControls } from './CanvasBackgroundControls'
import { Field } from './SettingsFields'
import { SettingsGroup, SettingsSegmented } from './SettingsControls'
import './canvasBackground.css'

const MODE_LABELS: Record<CanvasBackgroundMode, string> = { default: 'Default', color: 'Solid color', gradient: 'Gradient', image: 'Image' }

/** Differs from the default anywhere (key order normalized onto the default's, so a server copy compares equal). */
export const isDefaultBackground = (bg: CanvasBackground): boolean =>
  JSON.stringify({ ...DEFAULT_CANVAS_BACKGROUND, ...bg, gradient: { ...DEFAULT_CANVAS_BACKGROUND.gradient, ...bg.gradient } }) === JSON.stringify(DEFAULT_CANVAS_BACKGROUND)

interface Props {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  /** Active workspace; without one only the shared background can be edited. */
  projectId?: string
}

/** The Canvas background editor. */
export function CanvasBackgroundSection({ settings: s, onChange, projectId }: Props): React.JSX.Element {
  const [error, setError] = useState('')
  const own = projectId ? s.canvasBackgroundByWorkspace[projectId] : undefined
  // Custom = this workspace's own entry is edited; otherwise the shared one.
  const ws = own !== undefined && projectId ? projectId : null
  const bg = own ?? s.canvasBackground
  const wallpaper = useWallpaper(bg)

  // Workspace scope sends ONLY its own entry (`settings.patch.ts`; null = back to global), so a tab
  // with a stale copy of the map never overwrites other workspaces' overrides.
  const write = (next: CanvasBackground | null): void =>
    onChange(ws ? { canvasBackgroundByWorkspace: { [ws]: next } } : { canvasBackground: next ?? DEFAULT_CANVAS_BACKGROUND })
  const set = (patch: Partial<CanvasBackground>): void => write({ ...bg, ...patch })
  const fromServer = (saved: Settings): void =>
    write(ws ? saved.canvasBackgroundByWorkspace[ws] ?? null : saved.canvasBackground)
  const attempt = (op: () => Promise<void>): void => {
    setError('')
    op().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  // An image is removed through the server first, so its file is deleted, not orphaned.
  const dropImage = async (): Promise<void> => { if (bg.imageId) await removeCanvasImage(ws) }

  const reset = (): void => attempt(async () => {
    await dropImage()
    write(DEFAULT_CANVAS_BACKGROUND)
  })
  const setCustom = (custom: boolean): void => {
    if (!projectId || custom === (own !== undefined)) return
    // Starts as a copy of the shared one; a shared image id is safe (the server deletes only unreferenced files).
    if (custom) { onChange({ canvasBackgroundByWorkspace: { [projectId]: { ...s.canvasBackground } } }); return }
    attempt(async () => {
      if (own?.imageId) await removeCanvasImage(projectId)
      onChange({ canvasBackgroundByWorkspace: { [projectId]: null } })
    })
  }

  return (
    <div data-field="canvasBackground" className="cbg-section">
      <SettingsGroup title="Canvas background">
        {projectId && (
          <Field label="This workspace" htmlFor="cbg-scope" hint="Same as all workspaces, or a background of its own. The controls below edit the one in use.">
            <SettingsSegmented id="cbg-scope" ariaLabel="This workspace" value={own ? 'custom' : 'same'} onChange={(v) => setCustom(v === 'custom')}
              options={[{ value: 'same', label: 'Same as all workspaces' }, { value: 'custom', label: 'Custom' }]} />
          </Field>
        )}
        <Field label="Preview" block>
          <div className="cbg-preview" data-testid="canvas-background-preview">
            <CanvasBackgroundLayer bg={wallpaper.shown} imageUrl={wallpaper.imageUrl} />
            <div className="cbg-preview__dots" style={{ backgroundImage: `radial-gradient(${wallpaper.dotColor} 1.2px, transparent 1.2px)` }} />
            <div className="cbg-preview__node">Preview</div>
          </div>
        </Field>
        <Field label="Background style" htmlFor="cbg-mode" hint="Default keeps the theme's canvas color. Changes apply immediately."
          modified={!isDefaultBackground(bg)} onReset={reset}>
          <SettingsSegmented id="cbg-mode" ariaLabel="Background style" value={bg.mode} onChange={(mode) => set({ mode })}
            options={CANVAS_BG_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))} />
        </Field>
        {bg.mode === 'color' && <ColorControls bg={bg} onChange={set} />}
        {bg.mode === 'gradient' && <GradientControls bg={bg} onChange={set} />}
        {bg.mode === 'image' && (
          <ImageControls bg={bg} onChange={set}
            onUpload={async (file) => fromServer(await uploadCanvasImage(file, ws))}
            onRemove={async () => fromServer(await removeCanvasImage(ws))}
            missing={wallpaper.imageStatus === 'missing'}
            lowContrast={needsContrastWarning(bg, wallpaper.imageLuminance)} />
        )}
        {error && <p className="cbg-notice cbg-notice--error" role="alert">{error}</p>}
      </SettingsGroup>
    </div>
  )
}
