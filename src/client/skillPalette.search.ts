import type { CanvasSkill } from './skillNode.api'

/** Case-insensitive match on title, name and description; an empty query keeps every skill. */
export function matchesSkill(s: CanvasSkill, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || [s.title ?? '', s.name, s.description].some((v) => v.toLowerCase().includes(q))
}
