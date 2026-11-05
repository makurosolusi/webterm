import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import {
  CANVAS_BG_RANGES, DEFAULT_CANVAS_BACKGROUND, normalizeCanvasBackground, normalizeWorkspaceBackgrounds,
  referencedImageIds, resolveCanvasBackground, WORKSPACE_BACKGROUNDS_LIMITS,
} from './canvasBackground.schema'

const IMG = '0f8b1c2a-1111-4222-8333-444455556666.png' // test-only

describe('canvas background schema', () => {
  it('defaults to the default look and an empty per-workspace map', () => {
    expect(DEFAULT_SETTINGS.canvasBackground).toEqual(DEFAULT_CANVAS_BACKGROUND)
    expect(DEFAULT_SETTINGS.canvasBackground.mode).toBe('default')
    expect(DEFAULT_SETTINGS.canvasBackgroundByWorkspace).toEqual({})
    expect(mergeSettings(null).canvasBackground).toEqual(DEFAULT_CANVAS_BACKGROUND)
  })

  it('clamps ranges and falls back on garbage, field by field', () => {
    const bg = normalizeCanvasBackground({
      mode: 'video', color: 'red', gradient: { from: '#ABCDEF', to: 12, angle: 999 },
      imageBlur: -5, imageDim: 500, imageFit: 'stretch', imageGradientOverlay: 'yes',
    })
    expect(bg.mode).toBe('default')
    expect(bg.color).toBe(DEFAULT_CANVAS_BACKGROUND.color)
    expect(bg.gradient).toEqual({ from: '#abcdef', to: DEFAULT_CANVAS_BACKGROUND.gradient.to, angle: CANVAS_BG_RANGES.angle.max })
    expect(bg.imageBlur).toBe(CANVAS_BG_RANGES.imageBlur.min)
    expect(bg.imageDim).toBe(CANVAS_BG_RANGES.imageDim.max)
    expect(bg.imageFit).toBe('cover')
    expect(bg.imageGradientOverlay).toBe(false)
    expect(normalizeCanvasBackground({ imageDim: Number.NaN }).imageDim).toBe(DEFAULT_CANVAS_BACKGROUND.imageDim)
  })

  it('accepts only server-shaped image ids (no traversal, no client names)', () => {
    expect(normalizeCanvasBackground({ imageId: IMG }).imageId).toBe(IMG)
    for (const bad of ['../etc/passwd', 'cat.png', `${IMG}/..`, IMG.replace('.png', '.svg'), '/abs/x.png']) {
      expect(normalizeCanvasBackground({ imageId: bad }).imageId).toBe('')
    }
  })

  it('mergeSettings normalizes a partial stored object instead of taking it shallowly', () => {
    const s = mergeSettings({ canvasBackground: { mode: 'color', color: '#112233' } })
    expect(s.canvasBackground).toEqual({ ...DEFAULT_CANVAS_BACKGROUND, mode: 'color', color: '#112233' })
  })

  it('caps the per-workspace map and drops bad ids', () => {
    const many = Object.fromEntries(Array.from({ length: WORKSPACE_BACKGROUNDS_LIMITS.entries + 5 }, (_, i) => [`ws-${i}`, { mode: 'color' }]))
    expect(Object.keys(normalizeWorkspaceBackgrounds(many))).toHaveLength(WORKSPACE_BACKGROUNDS_LIMITS.entries)
    expect(normalizeWorkspaceBackgrounds({ ['x'.repeat(WORKSPACE_BACKGROUNDS_LIMITS.idLength + 1)]: {} })).toEqual({})
    expect(normalizeWorkspaceBackgrounds([1, 2])).toEqual({})
  })

  it('resolves workspace override -> global -> default', () => {
    const global = { ...DEFAULT_CANVAS_BACKGROUND, mode: 'color' as const, color: '#101010' }
    const own = { ...DEFAULT_CANVAS_BACKGROUND, mode: 'gradient' as const }
    const s = { canvasBackground: global, canvasBackgroundByWorkspace: { w1: own } }
    expect(resolveCanvasBackground(s, 'w1')).toBe(own)
    expect(resolveCanvasBackground(s, 'w2')).toBe(global)
    expect(resolveCanvasBackground(s, null)).toBe(global)
    expect(resolveCanvasBackground(undefined, 'w1')).toBe(DEFAULT_CANVAS_BACKGROUND)
  })

  it('collects every referenced image id', () => {
    const s = {
      canvasBackground: { ...DEFAULT_CANVAS_BACKGROUND, imageId: IMG },
      canvasBackgroundByWorkspace: { w1: { ...DEFAULT_CANVAS_BACKGROUND, imageId: '' } },
    }
    expect([...referencedImageIds(s)]).toEqual([IMG])
  })
})
