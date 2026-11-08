// `GET /api/central/tools`: what Central can do, read from the live registry, with what each tool may do at the
// current control level. The level decision is the guard's own `ladderDecision`, so the list cannot drift from it.
import type { RouteResult } from '../apiShared.types'
import { effectiveEnv, type Ca2Handle } from './ca2Boot'
import type { ControlLevel, Tier } from './contracts/level.types'
import { guardActionOf, ladderDecision } from './guard/controlGuard'
import { defEnabled } from './tools/toolTypes'

export const TOOLS_PATH = '/api/central/tools'

export type ToolGroup = 'projects' | 'workers' | 'tasks' | 'memory' | 'browser' | 'skills' | 'channels' | 'approvals' | 'other'
/** auto = runs without asking, asks = needs approval, blocked = not allowed at this level, off = switched off. */
export type ToolAccess = 'auto' | 'asks' | 'blocked' | 'off'
export interface CatalogTool { name: string; summary: string; group: ToolGroup; tier: Tier; on: boolean; access: ToolAccess }

/** Name prefix -> group, first match wins; anything unmatched is `other`. */
const GROUP_PREFIXES: ReadonlyArray<[string, ToolGroup]> = [
  ['project.', 'projects'], ['node.', 'projects'], ['canvas.', 'projects'], ['repo.', 'projects'], ['agent.', 'workers'],
  ['task.', 'tasks'], ['plan.', 'tasks'], ['goal.', 'tasks'], ['run.', 'tasks'],
  ['memory.', 'memory'], ['kb.', 'memory'], ['blackboard.', 'memory'], ['browser_', 'browser'], ['skill.', 'skills'],
  ['channel.', 'channels'], ['central_bot', 'channels'], ['approval.', 'approvals'],
]
const GROUP_ORDER: readonly ToolGroup[] = ['projects', 'workers', 'tasks', 'memory', 'browser', 'skills', 'channels', 'approvals', 'other']

export function toolGroupOf(name: string): ToolGroup {
  return GROUP_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'other'
}

/** Access of one tool at `level`; `tierMinimum` is the policy's data-driven tier floor. */
export function toolAccess(name: string, tier: Tier, on: boolean, level: ControlLevel, tierMinimum: (t: Tier) => ControlLevel): ToolAccess {
  if (!on) return 'off'
  const d = ladderDecision(guardActionOf(name), tier, level, tierMinimum)
  return d.verdict === 'deny' ? 'blocked' : d.verdict === 'needs_approval' ? 'asks' : 'auto'
}

/** The catalog body; only reached while Central is armed (the dispatcher answers nothing otherwise). */
export function toolsView(h: Ca2Handle): RouteResult {
  const level = h.guard.effectiveLevel(null)
  const env = effectiveEnv(h.env)
  const tierMinimum = (t: Tier): ControlLevel => h.guard.policy.store.tierMinimum(t)
  const tools: CatalogTool[] = h.registry.list().map((def) => {
    const on = defEnabled(def, env)
    return { name: def.name, summary: def.summary, group: toolGroupOf(def.name), tier: def.tier, on, access: toolAccess(def.name, def.tier, on, level, tierMinimum) }
  })
  tools.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { status: 200, body: { level, tools } }
}
