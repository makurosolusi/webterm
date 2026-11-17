// Skill rows of the spawn lists (the agent's Skills handle menu, the pane menu's "Skill…"): active, switched-on
// canvas skills, searchable, with a visible row for loading / failed / off / empty instead of a silent empty list.
import { useMemo } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { HandleEntry } from './handleMenu.model'
import { useCanvasSkills, type CanvasSkillsLoad } from './skillNode.api'
import { attachable } from './skillNode.model'
import type { SkillRef } from './skillNode.add'
import { SN } from './skillNode.labels'

const noop = (): void => undefined
const status = (label: string): HandleEntry[] => [{ id: 'skill-status', label, group: SN.pickerGroup, disabled: true, spawn: noop }]

/** Pure: the rows for a library lookup. `add` places the node (and cables it, for the handle menu) at the given point. */
export function skillEntries(load: CanvasSkillsLoad, add: (s: SkillRef, at: XYPosition) => void): HandleEntry[] {
  if (load.status === 'loading') return status(SN.pickerLoading)
  if (load.status === 'error') return status(SN.pickerFailed)
  if (load.status === 'off') return status(SN.pickerOff)
  const skills = attachable(load.skills)
  if (!skills.length) return status(SN.pickerEmpty)
  return skills.map((s) => ({
    id: s.name, label: s.name, group: SN.pickerGroup, description: s.description || undefined,
    spawn: (at: XYPosition) => add({ name: s.name, version: s.version }, at),
  }))
}

/** Loads the library while `active` and offers it as spawn rows; `add` absent (no board) = no rows at all. */
export function useSkillEntries(active: boolean, add: ((s: SkillRef, at: XYPosition) => void) | undefined): HandleEntry[] {
  const lib = useCanvasSkills(active && !!add)
  const key = lib.status === 'ready' ? lib.skills : lib.status
  return useMemo(() => (active && add ? skillEntries(lib.status === 'ready' ? { status: 'ready', skills: lib.skills } : { status: lib.status }, add) : []),
    // `lib` is rebuilt every render; its content is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lib` is a fresh object each render, so listing it would defeat the memo; `key` stands in for it until useCanvasSkills returns a stable reference
    [active, add, key])
}
