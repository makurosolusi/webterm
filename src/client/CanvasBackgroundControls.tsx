// Per-mode controls of the Canvas background editor: color, gradient, image. Every change goes
// straight to `onChange`, so the canvas and the preview update live while editing.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CANVAS_BG_RANGES, CANVAS_IMAGE_FITS, MAX_CANVAS_IMAGE_BYTES, type CanvasBackground, type CanvasGradient, type CanvasImageFit,
} from '../shared/canvasBackground.schema'
import { IMAGE_TOO_LARGE_MESSAGE } from './canvasBackground.api'
import { COLOR_PRESETS, GRADIENT_PRESETS } from './canvasBackground.presets'
import { gradientCss, RECOMMENDED_IMAGE_DIM } from './canvasBackground.style'
import { Field } from './SettingsFields'
import { Switch } from '@/components/ui/switch'
import { SettingsSegmented } from './SettingsControls'

type Patch = (patch: Partial<CanvasBackground>) => void

const FIT_LABELS: Record<CanvasImageFit, string> = { cover: 'Fill', contain: 'Fit', tile: 'Tile' }

function Range({ id, label, value, range, unit, onChange }: {
  id: string; label: string; value: number; range: { min: number; max: number; step: number }; unit: string; onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <Field label={label} htmlFor={id}>
      <span className="st-slider" data-control="slider">
        <span className="st-slider-bound" aria-hidden="true">{range.min}{unit}</span>
        <Input id={id} type="range" className="st-range" min={range.min} max={range.max} step={range.step} value={value} aria-valuetext={`${value}${unit}`}
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
  lowContrast: boolean
}

/** Upload + blur/dim/overlay/fit, with the missing-file notice and the contrast guard. */
export function ImageControls({ bg, onChange, onUpload, onRemove, missing, lowContrast }: ImageControlsProps): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = (op: () => Promise<void>): void => {
    setBusy(true)
    setError('')
    op().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  const pick = (file: File | undefined): void => {
    if (!file) return
    if (file.size > MAX_CANVAS_IMAGE_BYTES) { setError(IMAGE_TOO_LARGE_MESSAGE); return }
    run(() => onUpload(file))
  }
  return (
    <>
      <Field label="Image" htmlFor="cbg-file" hint="PNG, JPEG, WebP or GIF up to 10 MB. Stored in the webterm data folder.">
        <Input id="cbg-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy}
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        {bg.imageId && (
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => run(onRemove)}>Remove image</Button>
        )}
      </Field>
      {error && <p className="cbg-notice cbg-notice--error" role="alert">{error}</p>}
      {missing && (
        <p className="cbg-notice" role="status">
          The background image file is missing, so the default background is shown. Upload it again or choose another style.
        </p>
      )}
      {lowContrast && (
        <div className="cbg-notice" role="status">
          <span>This image is bright and barely dimmed, so nodes and grid dots may be hard to see.</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ imageDim: RECOMMENDED_IMAGE_DIM })}>
            Use recommended dim
          </Button>
        </div>
      )}
      <Range id="cbg-blur" label="Blur" value={bg.imageBlur} range={CANVAS_BG_RANGES.imageBlur} unit="px" onChange={(imageBlur) => onChange({ imageBlur })} />
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
