// Per-mode controls of the Canvas background editor: color, gradient, image. Every change goes
// straight to `onChange`, so the canvas and the preview update live while editing.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CANVAS_BG_RANGES, CANVAS_IMAGE_FITS, CANVAS_PLAYBACKS, isCanvasVideoId, type CanvasBackground, type CanvasGradient, type CanvasImageFit, type CanvasPlayback,
} from '../shared/canvasBackground.schema'
import { IMAGE_TOO_LARGE_MESSAGE, VIDEO_TOO_LARGE_MESSAGE } from './canvasBackground.api'
import { isMovingMedia } from './canvasBackground.media'
import { usePrefersReducedMotion } from './canvasBackground.motion'
import {
  describeVideo, fileKindLabel, formatBytes, isVideoFile, kindLabel, maxBytesFor, probeVideoFile, videoWarnings, VIDEO_UNPLAYABLE_MESSAGE,
} from './canvasBackground.precheck'
import { COLOR_PRESETS, GRADIENT_PRESETS } from './canvasBackground.presets'
import { gradientCss, RECOMMENDED_IMAGE_DIM } from './canvasBackground.style'
import { Field } from './SettingsFields'
import { Switch } from '@/components/ui/switch'
import { SettingsSegmented, SettingsSelect } from './SettingsControls'

type Patch = (patch: Partial<CanvasBackground>) => void

const PLAYBACK_LABELS: Record<CanvasPlayback, string> = { always: 'Always', focused: 'When focused', off: 'Off' }
const FIT_LABELS: Record<CanvasImageFit, string> = { cover: 'Fill', contain: 'Fit', tile: 'Tile' }

function Range({ id, label, value, range, unit, onChange, disabled, hint }: {
  id: string; label: string; value: number; range: { min: number; max: number; step: number }; unit: string; onChange: (v: number) => void
  disabled?: boolean; hint?: string
}): React.JSX.Element {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <span className="st-slider" data-control="slider">
        <span className="st-slider-bound" aria-hidden="true">{range.min}{unit}</span>
        <Input id={id} type="range" className="st-range" min={range.min} max={range.max} step={range.step} value={value} disabled={disabled} aria-valuetext={`${value}${unit}`}
          onChange={(e) => onChange(Number(e.target.value))} />
        <span className="st-slider-bound" aria-hidden="true">{range.max}{unit}</span>
        <output htmlFor={id} className="st-slider-value">{value}{unit}</output>
      </span>
    </Field>
  )
}

export function Swatch({ label, background, selected, onClick }: { label: string; background: string; selected: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="sm" aria-pressed={selected} className="cbg-swatch" onClick={onClick}>
      <span className="cbg-swatch__chip" style={{ background }} aria-hidden />
      {label}
    </Button>
  )
}

/** Solid color: curated presets + native color picker. */
export function ColorControls({ bg, onChange }: { bg: CanvasBackground; onChange: Patch }): React.JSX.Element {
  return (
    <>
      <Field label="Color presets" hint="Muted tones that stay comfortable over long sessions." block>
        <div className="cbg-swatches">
          {COLOR_PRESETS.map((p) => (
            <Swatch key={p.color} label={p.label} background={p.color} selected={bg.color === p.color} onClick={() => onChange({ color: p.color })} />
          ))}
        </div>
      </Field>
      <Field label="Custom color" htmlFor="cbg-color">
        <Input id="cbg-color" type="color" className="cbg-color" value={bg.color} onChange={(e) => onChange({ color: e.target.value })} />
      </Field>
    </>
  )
}

/** Two colors + angle + presets. Also used for the image's gradient overlay. */
export function GradientControls({ bg, onChange }: { bg: CanvasBackground; onChange: Patch }): React.JSX.Element {
  const set = (g: Partial<CanvasGradient>): void => onChange({ gradient: { ...bg.gradient, ...g } })
  return (
    <>
      <Field label="Gradient presets" block>
        <div className="cbg-swatches">
          {GRADIENT_PRESETS.map((p) => (
            <Swatch key={p.label} label={p.label} background={gradientCss(p.gradient)}
              selected={bg.gradient.from === p.gradient.from && bg.gradient.to === p.gradient.to && bg.gradient.angle === p.gradient.angle} onClick={() => set(p.gradient)} />
          ))}
        </div>
      </Field>
      <Field label="Gradient start color" htmlFor="cbg-from">
        <Input id="cbg-from" type="color" className="cbg-color" value={bg.gradient.from} onChange={(e) => set({ from: e.target.value })} />
      </Field>
      <Field label="Gradient end color" htmlFor="cbg-to">
        <Input id="cbg-to" type="color" className="cbg-color" value={bg.gradient.to} onChange={(e) => set({ to: e.target.value })} />
      </Field>
      <Range id="cbg-angle" label="Gradient angle" value={bg.gradient.angle} range={CANVAS_BG_RANGES.angle} unit="°" onChange={(angle) => set({ angle })} />
    </>
  )
}

export interface ImageControlsProps {
  bg: CanvasBackground
  onChange: Patch
  /** Uploads the file (server stores it and saves settings). Rejects with a user-facing message. */
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
  missing: boolean
  /** The stored video cannot be played in this browser (the canvas shows the default look). */
  videoFailed?: boolean
  lowContrast: boolean
}

/** Upload + blur/dim/overlay/fit, with the missing-file notice and the contrast guard. */
export function ImageControls({ bg, onChange, onUpload, onRemove, missing, videoFailed = false, lowContrast }: ImageControlsProps): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** What the last pick in this session showed: size and, for video, resolution; the warnings never block. */
  const [note, setNote] = useState<{ label: string; warnings: string[] } | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const video = isCanvasVideoId(bg.imageId)
  const moving = isMovingMedia(bg)
  const run = (op: () => Promise<void>): void => {
    setBusy(true)
    setError('')
    op().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  const pick = (file: File | undefined): void => {
    if (!file) return
    const isVideo = isVideoFile(file)
    if (file.size > maxBytesFor(file)) { setError(isVideo ? VIDEO_TOO_LARGE_MESSAGE : IMAGE_TOO_LARGE_MESSAGE); return }
    run(async () => {
      const label = `${fileKindLabel(file)} · ${formatBytes(file.size)}`
      let next = { label, warnings: [] as string[] }
      if (isVideo) {
        const info = await probeVideoFile(file) // an unplayable video is refused here, before it is uploaded
        if (!info) throw new Error(VIDEO_UNPLAYABLE_MESSAGE)
        next = { label: `${label} · ${describeVideo(info)}`, warnings: videoWarnings(info, file.size) }
      }
      await onUpload(file)
      setNote(next)
    })
  }
  const blurHint = video ? 'Blur is not applied to video' : moving && bg.imageBlur > 0 ? 'Blur on an animated image uses more CPU' : undefined
  return (
    <>
      <Field label="Image or video" htmlFor="cbg-file"
        hint="PNG, JPEG, WebP or GIF up to 25 MB (animated WebP and GIF move); MP4 (H.264) or WebM up to 100 MB. For video, a 10-30 s loop at 1080p without audio is plenty. Free clips: Pexels, Pixabay. Stored in the webterm data folder.">
        <Input id="cbg-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" disabled={busy}
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        {bg.imageId && <span className="cbg-media-info" data-testid="cbg-media-info">{note?.label ?? kindLabel(bg.imageId)}</span>}
        {bg.imageId && (
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => run(async () => { setNote(null); await onRemove() })}>Remove</Button>
        )}
      </Field>
      {note?.warnings.map((w) => <p key={w} className="cbg-notice" role="status">{w}</p>)}
      {moving && (
        <Field label="Playback" htmlFor="cbg-playback"
          hint={reducedMotion && bg.playback !== 'always'
            ? 'Your system asks for reduced motion, so this stays still. Choose Always to play it anyway.'
            : 'Always keeps it moving. When focused pauses it while this window is in the background. Off shows one still frame.'}>
          <SettingsSelect id="cbg-playback" ariaLabel="Playback" value={bg.playback} onChange={(playback) => onChange({ playback })}
            options={CANVAS_PLAYBACKS.map((p) => ({ value: p, label: PLAYBACK_LABELS[p] }))} />
        </Field>
      )}
      {error && <p className="cbg-notice cbg-notice--error" role="alert">{error}</p>}
      {missing && !videoFailed && (
        <p className="cbg-notice" role="status">
          The background image file is missing, so the default background is shown. Upload it again or choose another style.
        </p>
      )}
      {videoFailed && <p className="cbg-notice cbg-notice--error" role="alert">{VIDEO_UNPLAYABLE_MESSAGE}</p>}
      {lowContrast && (
        <div className="cbg-notice" role="status">
          <span>This image is bright and barely dimmed, so nodes and grid dots may be hard to see.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ imageDim: RECOMMENDED_IMAGE_DIM })}>
            Use recommended dim
          </Button>
        </div>
      )}
      <Range id="cbg-blur" label="Blur" value={bg.imageBlur} range={CANVAS_BG_RANGES.imageBlur} unit="px" disabled={video} hint={blurHint}
        onChange={(imageBlur) => onChange({ imageBlur })} />
      <Range id="cbg-dim" label="Dim" value={bg.imageDim} range={CANVAS_BG_RANGES.imageDim} unit="%" onChange={(imageDim) => onChange({ imageDim })} />
      <Field label="Image fit" htmlFor="cbg-fit">
        <SettingsSegmented id="cbg-fit" ariaLabel="Image fit" value={bg.imageFit} options={CANVAS_IMAGE_FITS.map((f) => ({ value: f, label: FIT_LABELS[f] }))}
          onChange={(imageFit) => onChange({ imageFit })} />
      </Field>
      <Field label="Gradient overlay" htmlFor="cbg-overlay" hint="Tint the image with the gradient below.">
        <Switch id="cbg-overlay" checked={bg.imageGradientOverlay} onCheckedChange={(imageGradientOverlay) => onChange({ imageGradientOverlay })} />
      </Field>
      {bg.imageGradientOverlay && <GradientControls bg={bg} onChange={onChange} />}
    </>
  )
}
