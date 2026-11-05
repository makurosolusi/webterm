// Curated wallpaper presets: muted, low-saturation tones that are easy on the eyes for long
// sessions (the Warp / iTerm2 idea), plus one light "paper" option.
import type { CanvasGradient } from '../shared/canvasBackground.schema'

/** Solid color presets. */
export const COLOR_PRESETS: readonly { label: string; color: string }[] = [
  { label: 'Charcoal', color: '#1e1f24' },
  { label: 'Midnight navy', color: '#141b2d' },
  { label: 'Slate', color: '#2a3038' },
  { label: 'Deep plum', color: '#2a1e2e' },
  { label: 'Forest', color: '#17241e' },
  { label: 'Espresso', color: '#2a211c' },
  { label: 'Graphite blue', color: '#232a33' },
  { label: 'Paper', color: '#ece8df' },
]

/** Gradient presets. */
export const GRADIENT_PRESETS: readonly { label: string; gradient: CanvasGradient }[] = [
  { label: 'Dusk', gradient: { from: '#1b2234', to: '#2b1d33', angle: 135 } },
  { label: 'Deep sea', gradient: { from: '#0f1c2b', to: '#163235', angle: 160 } },
  { label: 'Ember', gradient: { from: '#1f1a1a', to: '#3a2420', angle: 120 } },
  { label: 'Moss', gradient: { from: '#161d18', to: '#25332a', angle: 200 } },
  { label: 'Steel', gradient: { from: '#1c1f26', to: '#343a45', angle: 90 } },
  { label: 'Dawn paper', gradient: { from: '#f1ece2', to: '#dfe5ea', angle: 135 } },
]
