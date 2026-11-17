// Compact per-goal map of what Central can do and whether each runs on its own (auto), asks first (asks), is
// not allowed at the current level (blocked) or is switched off (off). It reads the live catalog (`toolsView`,
// the same `toolAccess` the Settings list shows), so it follows the control level. It changes with the level,
// so it rides in the volatile prompt tail next to the state header, never in the cached steward prompt.
// ca2Boot registers the source; the assembler only reads it, so this module stays free of the boot graph.
import { renderCapabilityProse, type CapabilityId } from '../../../shared/agentCapabilities'
import { createLogger } from '../../logs'
import { PLAYBOOKS, playbookTool } from '../playbooks/playbook.defs'

const log = createLogger('central')

type Access = 'auto' | 'asks' | 'blocked' | 'off'
export interface MapTool { name: string; access: Access }

/** Goal -> the tools that serve it, in the order Central should reach for them. */
const GOALS: ReadonlyArray<[string, readonly string[]]> = [
  ['read one web page', ['browser_read']],
  ['research the web', ['playbook.web_research']],
  ['change code', ['playbook.code_change']],
  ['review', ['playbook.review']],
  // Central skills are written with the human in the Skills tab (author mode), never by a spawned worker; Central may also draft one itself.
  ['create or edit a Central skill', ['skill.propose']],
  ['delegate by hand', ['task.create', 'agent.spawn', 'agent.prompt']],
  // Indirect reach: a spawned worker is a full Claude Code agent (not locked like Central) and can message sessions outside the canvas.
  ['reach a Claude session outside the canvas', ['task.create', 'agent.spawn']],
  ['open a node next to another and cable it (one call)', ['canvas.open']],
  ['attach or detach a canvas skill on an agent (skill node cabled to its Skills port)', ['canvas.open', 'canvas.edit']],
  ['show the user something (fit, focus, zoom, pan; yields while they move the canvas)', ['canvas.camera']],
  ['switch the workspace the user sees (yields while they move the canvas)', ['workspace.switch']],
  ['undo your own canvas.close', ['canvas.reopen']],
  ['browse yourself', ['browser_act']],
  ['project health', ['health.scan']],
  ['remember', ['memory.remember']],
  // Delegated work reports by itself (a check-in); reminders are only for what time alone can tell.
  ['follow up later (not delegated work)', ['reminder.set']],
]
const WORST: readonly Access[] = ['auto', 'asks', 'blocked', 'off']
/** A playbook asks when any required step asks: its own tier says nothing about the spawn card inside. */
const CHAINS = new Map(PLAYBOOKS.map((pb) => [playbookTool(pb.id), pb.steps.filter((s) => !s.optional).map((s) => s.tool)]))

/** Registry abilities of the steward whose tool is switched off in this turn's catalog (feature or env flag off). */
export function stewardOffAbilities(tools: readonly MapTool[]): Set<CapabilityId> {
  const off = new Set<CapabilityId>()
  for (const t of tools) {
    if (t.access !== 'off') continue
    if (t.name === 'browser_read') off.add('web.read')
    if (t.name === 'browser_act') off.add('web.drive')
  }
  return off
}

/** Renders the map from catalog rows; goals whose tools are not registered are left out. */
export function renderCapabilityMap(tools: readonly MapTool[]): string {
  const access = new Map(tools.map((t) => [t.name, t.access]))
  const of = (name: string): Access | undefined => {
    const own = access.get(name)
    if (own === undefined) return undefined
    const all = [own, ...(CHAINS.get(name) ?? []).map((s) => access.get(s) ?? 'off')]
    return all.reduce((a, b) => (WORST.indexOf(b) > WORST.indexOf(a) ? b : a))
  }
  const goals = GOALS.map(([goal, names]) => {
    const parts = names.flatMap((n) => { const a = of(n); return a ? [`${n} (${a})`] : [] })
    return parts.length ? `${goal}: ${parts.join(', ')}` : ''
  }).filter((g) => g !== '')
  const off = stewardOffAbilities(tools)
  const notice = off.size ? ` ${renderCapabilityProse('central.steward', [...off], off)}` : ''
  return goals.length ? `Capabilities: ${goals.join(' · ')}${notice}` : ''
}

let source: () => readonly MapTool[] = () => []

/** Registers where the catalog rows are read from (ca2Boot, while Central is armed); returns the unregister. */
export function registerCapabilityMap(get: () => readonly MapTool[]): () => void {
  source = get
  return () => { if (source === get) source = () => [] }
}

/** The catalog rows of this turn; empty when Central is not armed or the read failed. */
export function currentTools(): readonly MapTool[] {
  try {
    return source()
  } catch (err) {
    // The map and hint are advisory: a broken catalog read must not break the turn.
    log.warn('central.capability_map_failed', 'capability map skipped', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/** The current map line, '' when Central is not armed. */
export const capabilityMapLine = (tools: readonly MapTool[] = currentTools()): string => renderCapabilityMap(tools)

/** True when `name` is registered and switched on for this turn. */
export const toolUsable = (tools: readonly MapTool[], name: string): boolean => tools.some((t) => t.name === name && t.access !== 'off')
