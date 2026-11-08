// Worker identity: a stable color chip, and the rules for when a title may be replaced by a
// task-derived one (the node's unique name lives in `shared/nodeNames.ts`). Imitates Orca:
//  - "is this still ours to rename?" by pool membership after stripping one `-N` suffix
//    (`shared/branch-name-from-work.ts:13-21`), so no extra persisted flag is needed: a user rename
//    leaves the pool and is never overwritten.
import type { AgentStatus } from '../shared/workspace'
import { uniqueTitle } from '../shared/nodeTitle'

export { uniqueTitle }

const ADJECTIVES = [
  'amber', 'bold', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', 'eager', 'fuzzy', 'gentle',
  'golden', 'happy', 'humble', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'nimble', 'quiet',
  'rapid', 'sunny', 'swift', 'witty',
] as const
const NOUNS = [
  'badger', 'beacon', 'comet', 'falcon', 'ferret', 'fox', 'gecko', 'heron', 'koala', 'lynx',
  'marten', 'meadow', 'otter', 'owl', 'panda', 'pebble', 'puffin', 'quokka', 'raven', 'river',
  'sparrow', 'tiger', 'walrus', 'willow',
] as const

const ADJ = new Set<string>(ADJECTIVES)
const NOUN = new Set<string>(NOUNS)

/** True when `title` is absent or still a generated `<adjective>-<noun>[-N]` name. */
export function isAutoName(title: string | undefined): boolean {
  if (!title) return true
  const m = /^([a-z]+)-([a-z]+)(?:-\d+)?$/.exec(title.trim().toLowerCase())
  return !!m && ADJ.has(m[1]) && NOUN.has(m[2])
}

/** Stable identity color for a node id (FNV-1a hue), independent of the user-picked node color. */
export function identityColor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return `hsl(${(h >>> 0) % 360}, 65%, 55%)`
}

/** Statuses that mean "nothing is running and nobody is being asked": safe to bulk-stop. */
const IDLE: ReadonlySet<AgentStatus | undefined> = new Set<AgentStatus | undefined>(['waiting', 'done'])

/** Agent nodes on the board whose turn ended or session finished. Running/blocked/unknown are kept. */
export function idleAgentIds(
  nodes: readonly { id: string; type?: string }[],
  statusOf: (id: string) => AgentStatus | undefined,
): string[] {
  return nodes.filter((n) => n.type === 'agent' && IDLE.has(statusOf(n.id))).map((n) => n.id)
}

/** Statuses after which the session is over and its conversation can be resumed: it finished, or
 *  the user stopped it (A5). `failed` is excluded: it offers Retry, which resumes when it can. */
const RESUMABLE_AFTER: ReadonlySet<AgentStatus | undefined> = new Set<AgentStatus | undefined>(['done', 'stopped'])
export const canResumeAfter = (status: AgentStatus | undefined): boolean => RESUMABLE_AFTER.has(status)

type SendClose = (msg: { t: 'close'; id: string }) => void
type Confirm = (question: string) => boolean
const browserConfirm: Confirm = (q) => window.confirm(q)

/** Stop one agent: confirm, then the existing `close` message (kills the PTY, the node stays). */
export function stopAgent(id: string, title: string, send: SendClose, confirm: Confirm = browserConfirm): boolean {
  if (!confirm(`Stop agent "${title}"? Its session ends; the node stays and can be resumed.`)) return false
  send({ t: 'close', id })
  return true
}

/** Stop every idle/finished agent on the board after one confirm. Returns how many were stopped. */
export function stopIdleAgents(
  nodes: readonly { id: string; type?: string }[],
  statusOf: (id: string) => AgentStatus | undefined,
  send: SendClose,
  confirm: Confirm = browserConfirm,
  notify: (message: string) => void = (m) => window.alert(m),
): number {
  const ids = idleAgentIds(nodes, statusOf)
  // Said out loud: a menu item that silently does nothing reads as broken.
  if (!ids.length) { notify('No idle or finished agents on this board.'); return 0 }
  if (!confirm(`Stop ${ids.length} idle or finished agent${ids.length === 1 ? '' : 's'} on this board? Running and blocked agents are left alone.`)) return 0
  for (const id of ids) send({ t: 'close', id })
  return ids.length
}

export interface AutoTitleDeps {
  getTitle: () => string | undefined
  /** Titles of the OTHER nodes on the board. */
  boardTitles: () => string[]
  setTitle: (title: string) => void
  /** Server naming (`/api/generate-name`): first prompt from the transcript, else terminal output. */
  generate: () => Promise<{ ok: boolean; message: string }>
}

/**
 * First-work rename (Orca `main/agent-hooks/first-work-branch-rename.ts:100-139`): only while the
 * title is still a generated name, and only if nobody renamed it during generation
 * (`first-work-workspace-title-rename.ts:46-52`). A user rename always wins.
 */
export async function autoTitleFromWork(nodeId: string, deps: AutoTitleDeps): Promise<boolean> {
  const original = deps.getTitle()
  if (!isAutoName(original)) return false
  let r: { ok: boolean; message: string }
  try {
    r = await deps.generate()
  } catch (e) {
    console.warn(`auto-title node ${nodeId}: naming request failed`, e)
    return false
  }
  // Not an error worth surfacing: the generated name stays and the next turn retries.
  if (!r.ok) { console.warn(`auto-title node ${nodeId}: ${r.message}`); return false }
  if (deps.getTitle() !== original) return false
  deps.setTitle(uniqueTitle(r.message, deps.boardTitles()))
  return true
}
