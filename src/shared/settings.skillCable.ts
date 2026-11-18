// Settings › Canvas › Skill cable color / size. Values are ids, never free hex or px: the color is `default` (the
// accent) or a workspace palette hue (contrast-checked tokens, `workspaceColor.ts`), the size one of four names.
import { WORKSPACE_HUES, isWorkspaceHue } from './workspaceColor'

export const SKILL_CABLE_COLOR_DEFAULT = 'default'
/** Ids a `skillCableColor` may hold. */
export const SKILL_CABLE_COLORS: readonly string[] = [SKILL_CABLE_COLOR_DEFAULT, ...WORKSPACE_HUES]

export const SKILL_CABLE_SIZES = ['thin', 'normal', 'thick', 'xthick'] as const
export type SkillCableSize = (typeof SKILL_CABLE_SIZES)[number]
export const SKILL_CABLE_SIZE_DEFAULT: SkillCableSize = 'normal'
/** Line width in px per size; `normal` is the width the cable always had. Hover/selected add `SKILL_CABLE_HOT_EXTRA`. */
export const SKILL_CABLE_WIDTH_PX: Record<SkillCableSize, number> = { thin: 1, normal: 1.5, thick: 3, xthick: 4 }
export const SKILL_CABLE_HOT_EXTRA = 1.5

export const isSkillCableColor = (v: unknown): v is string => v === SKILL_CABLE_COLOR_DEFAULT || isWorkspaceHue(v)
export const isSkillCableSize = (v: unknown): v is SkillCableSize => typeof v === 'string' && (SKILL_CABLE_SIZES as readonly string[]).includes(v)
