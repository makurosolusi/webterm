// Live status of each skill node on the board, so a SkillEdge (a different React subtree) can style itself from the
// node it starts at without a second library lookup. In-memory only: never saved with the workspace.
import { useSyncExternalStore } from 'react'
import type { SkillStatus } from './skillNode.model'

const status = new Map<string, SkillStatus>()
const listeners = new Set<() => void>()

/** Records `s` for node `id` (undefined forgets it, on unmount). */
export function setSkillStatus(id: string, s: SkillStatus | undefined): void {
  if (status.get(id) === s) return
  if (s) status.set(id, s); else status.delete(id)
  listeners.forEach((l) => l())
}

/** Status of skill node `id`; undefined until that node has rendered. */
export function useSkillStatus(id: string): SkillStatus | undefined {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => status.get(id))
}
