// Skill cable look from Settings: CSS variables on the canvas root (the `--edge-color` pattern of the other cables),
// read by `SkillEdge`. Defaults set nothing, so an untouched install renders exactly as before.
import type { CSSProperties } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { SKILL_CABLE_HOT_EXTRA, SKILL_CABLE_WIDTH_PX } from '../shared/settings.skillCable'
import { workspaceColorVar } from '../shared/workspaceColor'

/** Width in px of a plain skill cable; the stylesheet's own value (`normal`). */
export const SKILL_EDGE_WIDTH_FALLBACK = `${SKILL_CABLE_WIDTH_PX.normal}px`
export const SKILL_EDGE_STROKE = 'var(--skill-edge-color, var(--accent))'
export const SKILL_EDGE_WIDTH = `var(--skill-edge-width, ${SKILL_EDGE_WIDTH_FALLBACK})`
/** Hover / selected: a fixed step thicker than the chosen width, so Thin stays thinner than Thick when hot. */
export const SKILL_EDGE_WIDTH_HOT = `calc(${SKILL_EDGE_WIDTH} + ${SKILL_CABLE_HOT_EXTRA}px)`
/** Minimum hit area of the cable line (px), whatever its drawn width. */
export const SKILL_EDGE_MIN_HIT = 12

/** Color token of a stored `skillCableColor` (`default` = the accent). */
export const skillCableColorCss = (color: string): string => (color === DEFAULT_SETTINGS.skillCableColor ? 'var(--accent)' : workspaceColorVar(color, 'default'))

/** Root variables for the chosen color and size; only non-default choices are written. */
export function skillCableVars(s: Pick<Settings, 'skillCableColor' | 'skillCableSize'>): CSSProperties | undefined {
  const vars: Record<string, string> = {}
  if (s.skillCableColor !== DEFAULT_SETTINGS.skillCableColor) vars['--skill-edge-color'] = skillCableColorCss(s.skillCableColor)
  if (s.skillCableSize !== DEFAULT_SETTINGS.skillCableSize) vars['--skill-edge-width'] = `${SKILL_CABLE_WIDTH_PX[s.skillCableSize]}px`
  return Object.keys(vars).length ? (vars as CSSProperties) : undefined
}
