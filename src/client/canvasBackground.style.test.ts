import { describe, expect, it } from 'vitest'
import { DEFAULT_CANVAS_BACKGROUND, IMAGE_GRADIENT_OVERLAY_OPACITY, type CanvasBackground } from '../shared/canvasBackground.schema'
import {
  backgroundLuminance, DEFAULT_DOT, DOT_ON_DARK, DOT_ON_LIGHT, dotColorFor, hexLuminance, layerStyles, needsContrastWarning,
  RECOMMENDED_IMAGE_DIM,
} from './canvasBackground.style'
import { COLOR_PRESETS } from './canvasBackground.presets'

const IMG = '0f8b1c2a-1111-4222-8333-444455556666.png' // test-only
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, ...p })

describe('luminance -> dot color', () => {
  it('computes WCAG luminance at the extremes', () => {
    expect(hexLuminance('#000000')).toBe(0)
    expect(hexLuminance('#ffffff')).toBeCloseTo(1, 5)
  })

  it('keeps the theme dot on the default background', () => {
    expect(dotColorFor(backgroundLuminance(DEFAULT_CANVAS_BACKGROUND))).toBe(DEFAULT_DOT)
  })

  it('uses dark dots on light colors and light dots on dark colors', () => {
    const paper = COLOR_PRESETS.find((p) => p.label === 'Paper')?.color ?? ''
    expect(dotColorFor(backgroundLuminance(bg({ mode: 'color', color: paper })))).toBe(DOT_ON_LIGHT)
    expect(dotColorFor(backgroundLuminance(bg({ mode: 'color', color: '#141b2d' })))).toBe(DOT_ON_DARK)
  })

  it('averages the two gradient stops', () => {
    const l = backgroundLuminance(bg({ mode: 'gradient', gradient: { from: '#000000', to: '#ffffff', angle: 0 } }))
    expect(l).toBeCloseTo(0.5, 5)
  })

  it('dims the sampled image luminance and mixes the overlay in', () => {
    expect(backgroundLuminance(bg({ mode: 'image', imageId: IMG, imageDim: 50 }), 0.8)).toBeCloseTo(0.4, 5)
    const withOverlay = bg({ mode: 'image', imageId: IMG, imageDim: 0, imageGradientOverlay: true, gradient: { from: '#000000', to: '#000000', angle: 0 } })
    expect(backgroundLuminance(withOverlay, 1)).toBeCloseTo(1 - IMAGE_GRADIENT_OVERLAY_OPACITY, 5)
  })
})

describe('contrast guard', () => {
  const bright = bg({ mode: 'image', imageId: IMG, imageDim: 0 })
  it('warns for a bright, undimmed image and stops once the recommended dim is applied', () => {
    expect(needsContrastWarning(bright, 0.9)).toBe(true)
    expect(needsContrastWarning({ ...bright, imageDim: RECOMMENDED_IMAGE_DIM }, 0.9)).toBe(false)
  })
  it('does not warn for dark images, unknown samples or other modes', () => {
    expect(needsContrastWarning(bright, 0.05)).toBe(false)
    expect(needsContrastWarning(bright, null)).toBe(false)
    expect(needsContrastWarning(bg({ mode: 'color' }), 0.9)).toBe(false)
  })
})

describe('layer styles', () => {
  it('paints color and gradient, nothing for default', () => {
    expect(layerStyles(DEFAULT_CANVAS_BACKGROUND, null)).toBeNull()
    expect(layerStyles(bg({ mode: 'color', color: '#112233' }), null)?.base.background).toBe('#112233')
    expect(layerStyles(bg({ mode: 'gradient', gradient: { from: '#000000', to: '#ffffff', angle: 45 } }), null)?.base.background)
      .toBe('linear-gradient(45deg, #000000, #ffffff)')
  })

  it('image: blur once on the layer with bleed, dim overlay, fit and no layer without a URL', () => {
    const b = bg({ mode: 'image', imageId: IMG, imageBlur: 10, imageDim: 30, imageFit: 'tile', imageGradientOverlay: true })
    const s = layerStyles(b, '/img.png')
    expect(s?.base.backgroundImage).toBe('url("/img.png")')
    expect(s?.base.filter).toBe('blur(10px)')
    expect(s?.base.inset).toBe(-20)
    expect(s?.base.backgroundRepeat).toBe('repeat')
    expect(s?.dim?.background).toBe('rgba(0, 0, 0, 0.3)')
    expect(s?.overlay?.opacity).toBe(IMAGE_GRADIENT_OVERLAY_OPACITY)
    expect(layerStyles(b, null)).toBeNull()
    expect(layerStyles({ ...b, imageBlur: 0 }, '/img.png')?.base.filter).toBeUndefined()
  })
})
