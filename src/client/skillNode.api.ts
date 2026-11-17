// Library lookup for skill nodes and pickers: one GET of the canvas skills (the human Central route), parsed
// defensively. Per instance (a hook per node/picker), no module cache: a skill switched off or approved shows on the
// next mount or Retry. ponytail: one GET per skill node on board load; a shared board-level cache if boards hold dozens.
import { useCallback, useEffect, useState } from 'react'
import { request } from './inboxTransport'
import { InboxApiError } from './inboxTypes'
import { SKILLS_OFF, SKILLS_PATH } from './central/centralControlApi'

/** A canvas skill as the library lists it; `enabled` false = switched off. */
export interface CanvasSkill { name: string; version: string; description: string; enabled: boolean }

export type CanvasSkillsLoad =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'error' }
  | { status: 'ready'; skills: CanvasSkill[] }

const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Active canvas skills (switched on or off), newest rows as listed; central skills and drafts are left out. */
export async function fetchCanvasSkills(signal?: AbortSignal): Promise<CanvasSkill[]> {
  const body = await request<unknown>(`${SKILLS_PATH}?limit=200`, { signal })
  const items = Array.isArray(body) ? body : rec(body) && Array.isArray(body.items) ? body.items : []
  return items.flatMap((r): CanvasSkill[] => {
    if (!rec(r) || !rec(r.record)) return []
    const { name, version, status, audience, enabled } = r.record
    if (typeof name !== 'string' || !name || status !== 'active' || audience !== 'canvas') return []
    return [{ name, version: text(version), description: text(r.description), enabled: enabled !== false }]
  })
}

/** Loads the canvas skills while `active`; `reload` retries. A 503 `skills_off` is its own state, not an error. */
export function useCanvasSkills(active = true): CanvasSkillsLoad & { reload: () => void } {
  const [state, setState] = useState<CanvasSkillsLoad>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const ctl = new AbortController()
    setState({ status: 'loading' })
    fetchCanvasSkills(ctl.signal).then(
      (skills) => setState({ status: 'ready', skills }),
      (err: unknown) => { if (!ctl.signal.aborted) setState(err instanceof InboxApiError && err.code === SKILLS_OFF ? { status: 'off' } : { status: 'error' }) },
    )
    return () => ctl.abort()
  }, [active, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
