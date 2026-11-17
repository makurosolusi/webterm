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
  broadcast({ t: 'workspaceColor', workspaceId: id, color, shade })
  return { ok: true, change: { color, shade, previous } }
}

/** `list` without one occurrence of `value` (this workspace's own hue is not "used by another"). */
function removeOne(list: string[], value: string): string[] {
  const i = list.indexOf(value)
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
}
