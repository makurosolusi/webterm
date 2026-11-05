// Settings section "Canvas background": edits the global wallpaper or, for the active workspace,
// either "Same as global" or its own override. Changes apply live (canvas + preview box).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Settings } from '../shared/settings'
import { CANVAS_BG_MODES, DEFAULT_CANVAS_BACKGROUND, type CanvasBackground, type CanvasBackgroundMode } from '../shared/canvasBackground.schema'
import { removeCanvasImage, uploadCanvasImage } from './canvasBackground.api'
import { needsContrastWarning } from './canvasBackground.style'
import { CanvasBackgroundLayer, useWallpaper } from './CanvasBackgroundLayer'
import { ColorControls, GradientControls, ImageControls } from './CanvasBackgroundControls'
import { OPEN_SETTINGS_EVENT } from './claudeLauncher/claudeLaunch.client'
import { Field, useSettingsSearch } from './SettingsFields'
import { SettingsSelect } from './SettingsControls'
import './canvasBackground.css'

/** Settings section id; the `:workspace` suffix opens it scoped to the active workspace. */
export const CANVAS_BG_SECTION = 'background'
export const CANVAS_BG_WORKSPACE_SECTION = `${CANVAS_BG_SECTION}:workspace`

/** Open Settings on the Canvas background section, scoped to the active workspace. */
export function openWorkspaceCanvasBackground(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: CANVAS_BG_WORKSPACE_SECTION } }))
}

const MODE_LABELS: Record<CanvasBackgroundMode, string> = { default: 'Default', color: 'Solid color', gradient: 'Gradient', image: 'Image' }
type Scope = 'global' | 'workspace'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  /** Active workspace; without one only the global background can be edited. */
  projectId?: string
  initialScope?: Scope
}

/** The Canvas background editor. */
export function CanvasBackgroundSection({ settings: s, onChange, projectId, initialScope = 'global' }: Props): React.JSX.Element {
  const [scope, setScope] = useState<Scope>(projectId ? initialScope : 'global')
  const [error, setError] = useState('')
  const ws = scope === 'workspace' && projectId ? projectId : null
  const own = ws ? s.canvasBackgroundByWorkspace[ws] : undefined
  const bg = own ?? s.canvasBackground
  const editable = !ws || own !== undefined
  const wallpaper = useWallpaper(bg)
  // While searching, only matching fields show; the preview and actions would be noise.
  const searching = useSettingsSearch() !== ''

  const write = (next: CanvasBackground, map = s.canvasBackgroundByWorkspace): void =>
    onChange(ws ? { canvasBackgroundByWorkspace: { ...map, [ws]: next } } : { canvasBackground: next })
  const set = (patch: Partial<CanvasBackground>): void => write({ ...bg, ...patch })
  const fromServer = (saved: Settings): void =>
    onChange({ canvasBackground: saved.canvasBackground, canvasBackgroundByWorkspace: saved.canvasBackgroundByWorkspace })
  const attempt = (op: () => Promise<void>): void => {
    setError('')
    op().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  // An image is removed through the server first, so its file is deleted, not orphaned.
  const dropImage = async (): Promise<Settings | null> => (bg.imageId ? removeCanvasImage(ws) : null)

  const reset = (): void => attempt(async () => {
    const saved = await dropImage()
    write(DEFAULT_CANVAS_BACKGROUND, saved?.canvasBackgroundByWorkspace)
  })
  const setInherit = (inherit: boolean): void => {
    if (!ws) return
    // Starts as a copy of global; a shared image id is safe (the server deletes only unreferenced files).
    if (!inherit) { write({ ...s.canvasBackground }); return }
    attempt(async () => {
      const saved = await dropImage()
      const rest = { ...(saved?.canvasBackgroundByWorkspace ?? s.canvasBackgroundByWorkspace) }
      delete rest[ws]
      onChange({ canvasBackgroundByWorkspace: rest })
    })
  }

  return (
    <>
      {projectId && (
        <Field label="Edit background for" htmlFor="cbg-scope" hint="A workspace can follow the global background or have its own.">
          <SettingsSelect<Scope> id="cbg-scope" value={scope} onChange={setScope}
            options={[{ value: 'global', label: 'All workspaces' }, { value: 'workspace', label: 'This workspace' }]} />
        </Field>
      )}
      {ws && (
        <Field label="This workspace uses" htmlFor="cbg-inherit">
          <SettingsSelect id="cbg-inherit" value={own ? 'own' : 'inherit'} onChange={(v) => setInherit(v === 'inherit')}
            options={[{ value: 'inherit', label: 'Same as global' }, { value: 'own', label: 'Its own background' }]} />
        </Field>
      )}
      {!searching && (
        <div className="cbg-preview" data-testid="canvas-background-preview">
          <CanvasBackgroundLayer bg={wallpaper.shown} imageUrl={wallpaper.imageUrl} />
          <div className="cbg-preview__dots" style={{ backgroundImage: `radial-gradient(${wallpaper.dotColor} 1.2px, transparent 1.2px)` }} />
          <div className="cbg-preview__node">Preview</div>
        </div>
      )}
      {editable && (
        <>
          <Field label="Background style" htmlFor="cbg-mode" hint="Default keeps the theme's canvas color. Changes apply immediately.">
            <SettingsSelect id="cbg-mode" value={bg.mode} onChange={(mode) => set({ mode })}
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
          {!searching && (
            <div className="cbg-actions">
              <Button type="button" variant="secondary" size="sm" onClick={reset}>Reset to default</Button>
            </div>
          )}
        </>
      )}
      {error && <p className="cbg-notice cbg-notice--error" role="alert">{error}</p>}
    </>
  )
}
