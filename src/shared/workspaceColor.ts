// Workspace identity color: one of 12 named hues x 3 shades. Values are palette ids, never free hex,
// so every stored color is theme-checked (tokens in client/workspaceColor.css) and the server can
// reject anything unknown. The same ids are what the UI picker, the REST API and Central speak.

export const WORKSPACE_HUES = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink', 'slate'] as const
export const WORKSPACE_SHADES = ['soft', 'default', 'vivid'] as const

export type WorkspaceHue = (typeof WORKSPACE_HUES)[number]
export type WorkspaceShade = (typeof WORKSPACE_SHADES)[number]
export const DEFAULT_WORKSPACE_SHADE: WorkspaceShade = 'default'

/** True for a palette hue id. */
export const isWorkspaceHue = (v: unknown): v is WorkspaceHue => typeof v === 'string' && (WORKSPACE_HUES as readonly string[]).includes(v)
/** True for a palette shade id. */
export const isWorkspaceShade = (v: unknown): v is WorkspaceShade => typeof v === 'string' && (WORKSPACE_SHADES as readonly string[]).includes(v)

/** CSS value of a workspace color (a token defined in workspaceColor.css); an unknown hue falls back to slate. */
export function workspaceColorVar(hue: string | undefined, shade: string | undefined): string {
  return `var(--ws-${isWorkspaceHue(hue) ? hue : 'slate'}-${isWorkspaceShade(shade) ? shade : DEFAULT_WORKSPACE_SHADE})`
}

/** Display name of a hue, e.g. `Indigo`. */
export const workspaceHueLabel = (hue: WorkspaceHue): string => hue[0].toUpperCase() + hue.slice(1)

/** Human/model-facing phrase, e.g. `indigo vivid`; an unknown hue reads `unset`. */
export const describeWorkspaceColor = (hue: string | undefined, shade: string | undefined): string =>
  isWorkspaceHue(hue) ? `${hue} ${isWorkspaceShade(shade) ? shade : DEFAULT_WORKSPACE_SHADE}` : 'unset'

/** Stable hue for a workspace that has none yet (migration backfill): FNV-1a of the id, so it never changes between boots. */
export function backfillWorkspaceHue(id: string): WorkspaceHue {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  return WORKSPACE_HUES[h % WORKSPACE_HUES.length]
}

/**
 * Hue for a NEW workspace: a random one among those no other workspace uses, so tabs stay
 * distinguishable; with all 12 taken, a random one among the least used. `rand` is injected (0..1).
 */
export function pickWorkspaceColor(used: readonly (string | null | undefined)[], rand: () => number): WorkspaceHue {
  const count = new Map<WorkspaceHue, number>(WORKSPACE_HUES.map((h) => [h, 0]))
  for (const u of used) if (isWorkspaceHue(u)) count.set(u, (count.get(u) ?? 0) + 1)
  const least = Math.min(...count.values())
  const pool = WORKSPACE_HUES.filter((h) => count.get(h) === least)
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}
