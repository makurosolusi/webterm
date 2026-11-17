// Change a workspace's identity color: the one write path shared by `PUT /api/workspaces/:id/color`
// (the picker, the API) and Central's `workspace.color`. Validates against the palette, stores via
// `Db.setColor`, and tells every open window (`t:'workspaceColor'`) so tabs recolor without a reload.
import type { ServerMsg } from '../shared/protocol'
import { DEFAULT_WORKSPACE_SHADE, isWorkspaceHue, isWorkspaceShade, pickWorkspaceColor } from '../shared/workspaceColor'
import type { WorkspaceHue, WorkspaceShade } from '../shared/workspaceColor'
import type { Db } from './db'

/** Why a color change was refused; values are never echoed back. */
export type ColorRefusal = 'color' | 'shade' | 'empty' | 'not_found'

export interface ColorChange {
  color: WorkspaceHue
  shade: WorkspaceShade
  /** The color before this change, for the caller's notification/audit note. */
  previous: { color: string | undefined; shade: string | undefined }
}

/**
 * Apply `{ color?, colorShade?, random? }` to workspace `id`. Either field alone keeps the other as
 * stored; `random: true` picks a hue unused by the OTHER workspaces (same rule as creation).
 */
export function setWorkspaceColor(
  store: Pick<Db, 'get' | 'setColor' | 'usedHues'>,
  id: string,
  input: { color?: unknown; colorShade?: unknown; random?: unknown },
  broadcast: (msg: ServerMsg) => void,
  rand: () => number = Math.random,
  by?: 'central',
): { ok: true; change: ColorChange } | { ok: false; bad: ColorRefusal } {
  const ws = store.get(id)
  if (!ws) return { ok: false, bad: 'not_found' }
  const wantsRandom = input.random === true
  if (input.color === undefined && input.colorShade === undefined && !wantsRandom) return { ok: false, bad: 'empty' }
  if (input.color !== undefined && !isWorkspaceHue(input.color)) return { ok: false, bad: 'color' }
  if (input.colorShade !== undefined && !isWorkspaceShade(input.colorShade)) return { ok: false, bad: 'shade' }
  const previous = { color: ws.color, shade: ws.colorShade }
  const others = ws.color ? removeOne(store.usedHues(), ws.color) : store.usedHues()
  const color = input.color ?? (wantsRandom ? pickWorkspaceColor(others, rand) : (isWorkspaceHue(ws.color) ? ws.color : pickWorkspaceColor(others, rand)))
  const shade = input.colorShade ?? (isWorkspaceShade(ws.colorShade) ? ws.colorShade : DEFAULT_WORKSPACE_SHADE)
  if (!store.setColor(id, color, shade)) return { ok: false, bad: 'not_found' }
  broadcast({
    t: 'workspaceColor', workspaceId: id, color, shade,
    ...(by && isWorkspaceHue(previous.color) ? { by, name: ws.name, previous: { color: previous.color, shade: previous.shade ?? DEFAULT_WORKSPACE_SHADE } } : {}),
  })
  return { ok: true, change: { color, shade, previous } }
}

/** `list` without one occurrence of `value` (this workspace's own hue is not "used by another"). */
function removeOne(list: string[], value: string): string[] {
  const i = list.indexOf(value)
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
}

/** HTTP answers for a refused color change (`PUT /api/workspaces/:id/color`, and the color fields of a create). */
export const BAD_COLOR = { status: 400, body: { error: 'color must be a palette hue id' } }
export const BAD_SHADE = { status: 400, body: { error: 'colorShade must be soft, default or vivid' } }
const BAD_COLOR_EMPTY = { status: 400, body: { error: 'send color, colorShade or random' } }
const NOT_FOUND = { status: 404, body: { error: 'not found' } }

/** `PUT /api/workspaces/:id/color` with a parsed object body: apply, broadcast to every window, answer. */
export async function colorHttp(store: Db, id: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const { broadcastUi } = await import('./canvas/canvasPush.runtime')
  const r = setWorkspaceColor(store, id, body, broadcastUi)
  if (r.ok) return { status: 200, body: { color: r.change.color, colorShade: r.change.shade } }
  return r.bad === 'not_found' ? NOT_FOUND : r.bad === 'shade' ? BAD_SHADE : r.bad === 'empty' ? BAD_COLOR_EMPTY : BAD_COLOR
}

/** The color fields of a create body: validated palette ids (absent stay absent), or the field to refuse. */
export function createColor(b: Record<string, unknown>): { color?: WorkspaceHue; colorShade?: WorkspaceShade } | { bad: 'color' | 'shade' } {
  if (b.color != null && !isWorkspaceHue(b.color)) return { bad: 'color' }
  if (b.colorShade != null && !isWorkspaceShade(b.colorShade)) return { bad: 'shade' }
  return { color: b.color ?? undefined, colorShade: b.colorShade ?? undefined }
}
