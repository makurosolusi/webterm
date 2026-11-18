// Pure model of the "click a connection handle" spawn menu: which kinds a handle may spawn, how they
// read in the list, and where the new node lands. No React, no DOM (testable in the node env).
import type { Connection, XYPosition } from '@xyflow/react'
import { buildCanvasMenuRows, isSeparator } from './canvasMenu.model'
import type { CanvasMenuContext, CanvasMenuHandlers, CanvasMenuItem } from './canvasMenu.model'
import { canLink, DIFF_KIND } from './floatingEdge'
import type { LinkEnd } from './floatingEdge'
import { BROWSER_KIND } from '../shared/browser.contract'
import type { AgentId } from '../shared/workspace'
import { SKILL_KIND, SKILL_OUT, SKILLS_IN } from '../shared/skillPorts'
import type { SkillRef } from './skillNode.add'
import type { SpawnMode } from './browserProfile.spawn'

/** source = the right handle (spawns a target); target = the left handle (spawns a source). */
export type HandleSide = 'source' | 'target'

/** Which port was clicked: the context-link dot (default) or the typed skill diamond (`skill-out` / `skills-in`). */
export type HandlePort = 'link' | 'skill'

/** The node the handle belongs to. */
export interface HandleOrigin extends LinkEnd { side: HandleSide; port?: HandlePort }

/** A skill port whose menu is the skill list (an agent's Skills input), not the node spawner. */
export const offersSkills = (o: HandleOrigin): boolean => o.port === 'skill' && o.kind !== SKILL_KIND

/** Spawners the board offers; `at` is the FLOW point the new node is centred on. */
export interface HandleSpawners {
  addTerminal: (at: XYPosition) => void
  addFiles: (at: XYPosition) => void
  addAgent: (cmd: string, agentId: AgentId, at: XYPosition) => void
  /** Absent = browser capability off. */
  addBrowser?: (at: XYPosition) => void
  /** Opens the profile dialog (pick one / one per profile) for a browser spawned at `at`; absent = browser off. */
  openBrowserProfiles?: (mode: SpawnMode, at: XYPosition) => void
  addDiff?: (at: XYPosition) => void
  /** Absent = Claude disabled in settings. */
  addAgentChat?: (at: XYPosition) => void
  /** Places a skill node centred on `at`; the cable to the clicked Skills port follows. Absent = no board. */
  addSkill?: (skill: SkillRef, at: XYPosition) => void
  /** Same entry as a user-drawn cable (canLink + dedupe + save). */
  link: (c: Connection) => void
}

export const HANDLE_GROUP = 'Nodes'
export const OFF_HINTS: Record<string, string> = {
  browser: 'Browser is turned off',
  'browser-profile': 'Browser is turned off',
  'browser-each': 'Browser is turned off',
  diff: 'Diff is unavailable',
  agentChat: 'Claude is disabled in Settings',
}

export interface HandleEntry {
  id: string
  label: string
  group: string
  /** Agent colour dot. */
  dot?: string
  /** Visible reason, shown on disabled rows. */
  description?: string
  disabled?: boolean
  /** Spawn the node centred on `at`. */
  spawn: (at: XYPosition) => void
}

/** What a pane-menu row key spawns, for the cable-ability check; null = not a spawnable node. */
function endOf(key: string): LinkEnd | null {
  if (key === 'terminal' || key === 'files') return { id: 'new', kind: key }
  if (key === 'browser' || key === 'browser-profile' || key === 'browser-each') return { id: 'new', kind: BROWSER_KIND }
  if (key === 'diff') return { id: 'new', kind: DIFF_KIND }
  if (key === 'agentChat') return { id: 'new', kind: 'agentChat', agentId: 'claude' }
  if (key.startsWith('agent:')) return { id: 'new', kind: 'agent', agentId: key.slice(6) as AgentId }
  return null // select-all / fit-view / groups
}

/** The pane menu's own rows (same kinds, same agent filtering), flattened, with handlers bound to `at`. */
function paneItems(s: HandleSpawners, ctx: CanvasMenuContext, at: XYPosition): CanvasMenuItem[] {
  const noop = () => {}
  const handlers: CanvasMenuHandlers = {
    addTerminal: () => s.addTerminal(at),
    addFiles: () => s.addFiles(at),
    addAgent: (cmd, id) => s.addAgent(cmd, id, at),
    addBrowser: () => (s.addBrowser ?? noop)(at),
    addBrowserWithProfile: () => s.openBrowserProfiles?.('one', at),
    addBrowserForEachProfile: () => s.openBrowserProfiles?.('each', at),
    addDiff: () => (s.addDiff ?? noop)(at),
    addAgentChat: () => (s.addAgentChat ?? noop)(at),
    fitView: noop,
  }
  return buildCanvasMenuRows(handlers, ctx).flatMap((r) => (isSeparator(r) ? [] : (r.children ?? [r])))
}

/**
 * Entries a handle may spawn: pane-menu kinds minus those that could not be cabled to the origin.
 * Features that are off stay listed, disabled, with a visible reason.
 */
export function buildHandleEntries(s: HandleSpawners, ctx: CanvasMenuContext, from: HandleOrigin): HandleEntry[] {
  if (offersSkills(from)) return [] // the Skills input lists library skills (useSkillEntries), not node kinds
  const off: Record<string, boolean> = { browser: !s.addBrowser, 'browser-profile': !s.openBrowserProfiles, 'browser-each': !s.openBrowserProfiles, diff: !s.addDiff, agentChat: !s.addAgentChat }
  const origin: LinkEnd = { id: 'origin', kind: from.kind, agentId: from.agentId }
  return paneItems(s, ctx, { x: 0, y: 0 }).flatMap((item) => {
    const end = endOf(item.key)
    if (!end || !canLink(origin, end)) return []
    const disabled = off[item.key] === true
    return [{
      id: item.key, label: item.label, group: HANDLE_GROUP, dot: item.dot,
      disabled: disabled || undefined, description: disabled ? OFF_HINTS[item.key] : undefined,
      // Rebuilt for the real point: the pane model binds handlers without coordinates.
      spawn: (at: XYPosition) => paneItems(s, ctx, at).find((i) => i.key === item.key)?.onClick?.(),
    }]
  })
}

export interface Rect { x: number; y: number; width: number; height: number }

const SPAWN_GAP = 80

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Flow point the new node is CENTRED on: beside the origin (right for a source handle, left for a
 * target handle), top-aligned with it, pushed down until it overlaps no existing node.
 */
export function spawnCenter(origin: Rect, size: { width: number; height: number }, side: HandleSide, others: readonly Rect[]): XYPosition {
  const x = side === 'source' ? origin.x + origin.width + SPAWN_GAP : origin.x - SPAWN_GAP - size.width
  let y = origin.y
  // At most one push per existing node: each push clears the node that caused it.
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => overlaps({ x, y, ...size }, o))
    if (!hit) break
    y = hit.y + hit.height + SPAWN_GAP / 2
  }
  return { x: x + size.width / 2, y: y + size.height / 2 }
}

/**
 * Like `spawnCenter` for the typed skill ports, which sit on the top (skill output) and bottom (agent Skills input):
 * the new node goes BELOW an agent (`below`) or ABOVE a skill (`above`), left-aligned, pushed right past any node it would cover.
 */
export function spawnCenterVertical(origin: Rect, size: { width: number; height: number }, dir: 'above' | 'below', others: readonly Rect[]): XYPosition {
  const y = dir === 'below' ? origin.y + origin.height + SPAWN_GAP : origin.y - SPAWN_GAP - size.height
  let x = origin.x
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => overlaps({ x, y, ...size }, o))
    if (!hit) break
    x = hit.x + hit.width + SPAWN_GAP / 2
  }
  return { x: x + size.width / 2, y: y + size.height / 2 }
}

/** The cable for a spawn: a source handle cables origin -> new, a target handle new -> origin. */
export function cableFor(originId: string, newId: string, side: HandleSide, port: HandlePort = 'link'): Connection {
  const [source, target] = side === 'source' ? [originId, newId] : [newId, originId]
  return port === 'skill'
    ? { source, target, sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN }
    : { source, target, sourceHandle: 'link-out', targetHandle: 'link-in' }
}
