// The Central chat's `/` commands: a table plus the pure decision of what a sent message does.
// Central is webterm's orchestrator, not a raw Claude session, so its commands are its own: chat
// actions (new chat, history), `/approvals` (expands the chat's Needs-you strip), shortcuts into the Central control panel (status, halt…),
// and prompt shortcuts that expand into a well-formed request its tools can serve (`project.list`,
// `node.list`, `task.status`, `plan.propose`). Approved skills are listed as `/skill-name`. The menu
// itself is the shared composer completion (agentChat/completionMenu); only the source lives here.
import { COMMAND_RESULT_LIMIT, rankCommands, type ComposerCompletion } from '../agentChat/composerCompletion'
import { fuzzyFilter } from '../fuzzy'
import type { CentralTab } from '../secondarySideBar.store'

/** Chat-side actions; `approvals` expands the Needs-you strip (works with the Central panel off). */
export type ChatAction = 'new' | 'history' | 'help' | 'approvals'

/** What a command does: a chat action, a Central panel tab, or a prompt sent to Central. */
export type CentralCommandAction =
  | { kind: 'chat'; action: ChatAction }
  | { kind: 'panel'; tab: CentralTab; halt?: boolean }
  | { kind: 'prompt'; prompt: (arg: string) => string }

export interface CentralCommand {
  name: string
  description: string
  /** Shown beside the name; a command with a hint needs an argument. */
  argumentHint?: string
  run: CentralCommandAction
}

export interface CentralSkill { name: string; description: string }

/** Badge per command kind, shown at the right of a menu row. */
export const CENTRAL_BADGE = { chat: 'chat', panel: 'panel', prompt: 'ask', skill: 'skill' } as const

/** An argument without the full stop the template adds itself. */
const bare = (arg: string): string => arg.trim().replace(/[.!?]+$/, '')

/** Every command (panel ones only while the Central panel is on). Prompts are English, for the model. */
export const CENTRAL_COMMANDS: readonly CentralCommand[] = [
  { name: 'new', description: 'Start a new conversation', run: { kind: 'chat', action: 'new' } },
  { name: 'clear', description: 'Start a new conversation (same as /new)', run: { kind: 'chat', action: 'new' } },
  { name: 'history', description: 'Show past conversations', run: { kind: 'chat', action: 'history' } },
  { name: 'help', description: 'List the chat commands', run: { kind: 'chat', action: 'help' } },
  { name: 'approvals', description: 'Show everything that needs you (approvals, reviews, broken tasks)', run: { kind: 'chat', action: 'approvals' } },
  { name: 'status', description: "Show Central's budget and model", run: { kind: 'panel', tab: 'control' } },
  { name: 'level', description: 'Show the autonomy level', run: { kind: 'panel', tab: 'control' } },
  { name: 'agents', description: 'Show the agents Central runs', run: { kind: 'panel', tab: 'agents' } },
  { name: 'skills', description: 'Review proposed skills', run: { kind: 'panel', tab: 'skills' } },
  { name: 'memory', description: 'Show what Central remembers', run: { kind: 'panel', tab: 'memory' } },
  { name: 'halt', description: 'Stop all Central work (kill-switch, asks first)', run: { kind: 'panel', tab: 'control', halt: true } },
  { name: 'projects', description: 'Ask Central for your projects and their status', run: { kind: 'prompt', prompt: () => 'List my projects with their status.' } },
  { name: 'nodes', description: 'Ask Central for the nodes of a project', argumentHint: '<project>', run: { kind: 'prompt', prompt: (p) => `List the nodes in project ${bare(p)}.` } },
  { name: 'tasks', description: 'Ask Central for the tasks of a project', argumentHint: '<project>', run: { kind: 'prompt', prompt: (p) => `Show the task status of project ${bare(p)}.` } },
  { name: 'plan', description: 'Ask Central to propose a plan', argumentHint: '<goal>', run: { kind: 'prompt', prompt: (g) => `Propose a plan for: ${g.trim()}` } },
]

/** What sending a message does. `usage`: an argument is missing, nothing is sent and `draft` goes back in the box. */
export type CentralDecision =
  | { kind: 'send'; text: string }
  | { kind: 'chat'; action: ChatAction }
  | { kind: 'panel'; tab: CentralTab; halt?: boolean }
  | { kind: 'usage'; message: string; draft: string }

const COMMAND = /^\s*\/([A-Za-z0-9._:-]+)(?:\s+([\s\S]*))?$/

/** The commands on offer: panel shortcuts only while the Central panel is on, skills that do not shadow a command. */
export function centralCommandList(centralEnabled: boolean, skills: readonly CentralSkill[] = []): CentralCommand[] {
  const own = CENTRAL_COMMANDS.filter((c) => centralEnabled || c.run.kind !== 'panel')
  const taken = new Set(own.map((c) => c.name))
  const skillRows = skills.filter((s) => !taken.has(s.name)).map((s): CentralCommand => ({
    name: s.name, description: s.description, run: { kind: 'prompt', prompt: (arg) => `Use the "${s.name}" skill.${arg.trim() ? ` ${arg.trim()}` : ''}` },
  }))
  return [...own, ...skillRows]
}

/** What `text` does: a known command acts or expands; anything else is sent as typed. */
export function resolveCentralInput(text: string, commands: readonly CentralCommand[]): CentralDecision {
  const m = COMMAND.exec(text)
  const cmd = m && commands.find((c) => c.name === m[1].toLowerCase())
  if (!m || !cmd) return { kind: 'send', text }
  const arg = (m[2] ?? '').trim()
  if (cmd.run.kind === 'chat') return { kind: 'chat', action: cmd.run.action }
  if (cmd.run.kind === 'panel') return { kind: 'panel', tab: cmd.run.tab, ...(cmd.run.halt ? { halt: true } : {}) }
  if (cmd.argumentHint && !arg) return { kind: 'usage', message: `Usage: /${cmd.name} ${cmd.argumentHint}`, draft: `/${cmd.name} ` }
  return { kind: 'send', text: cmd.run.prompt(arg) }
}

const badgeOf = (c: CentralCommand, skills: readonly CentralSkill[]): string =>
  c.run.kind === 'prompt' && skills.some((s) => s.name === c.name) ? CENTRAL_BADGE.skill : CENTRAL_BADGE[c.run.kind]

/** How long a loaded skill or project list is reused before the next `/` or `@` asks again. */
export const CENTRAL_LIST_REUSE_MS = 30_000

export interface CentralCommandSources {
  centralEnabled: boolean
  /** Approved skills; a rejection (e.g. 503 `skills_off`) lists none. */
  loadSkills?: () => Promise<CentralSkill[]>
  /** Project names for `@`; absent = no `@` menu. */
  loadProjects?: () => Promise<string[]>
  now?: () => number
}

/** Cached loader: reused for CENTRAL_LIST_REUSE_MS; a failure lists nothing and is asked again next time. */
function cached<T>(load: (() => Promise<T[]>) | undefined, now: () => number): { get: () => Promise<T[]>; last: () => T[] } {
  let entry: { at: number; list: Promise<T[]> } | null = null
  let last: T[] = []
  return {
    get: () => {
      if (!load) return Promise.resolve([])
      if (entry && now() - entry.at <= CENTRAL_LIST_REUSE_MS) return entry.list
      const list = load().then((l) => { last = l; return l }, () => { entry = null; last = []; return [] as T[] })
      entry = { at: now(), list }
      return list
    },
    last: () => last,
  }
}

/** The Central chat's command source: the composer `completion` plus `resolve` for a sent message. */
export function createCentralCommands(src: CentralCommandSources): { completion: ComposerCompletion; resolve: (text: string) => CentralDecision } {
  const now = src.now ?? Date.now
  const skills = cached(src.centralEnabled ? src.loadSkills : undefined, now)
  const projects = cached(src.loadProjects, now)
  return {
    completion: {
      provider: async (t) => {
        if (t.kind === 'file') return fuzzyFilter(t.query, await projects.get(), COMMAND_RESULT_LIMIT).map((name) => ({ value: name, badge: 'project' }))
        const loaded = await skills.get()
        return rankCommands(centralCommandList(src.centralEnabled, loaded), t.query).map((c) => ({
          value: c.name, description: c.description, argumentHint: c.argumentHint, badge: badgeOf(c, loaded),
        }))
      },
      text: { file: { label: 'Projects', empty: 'No matching projects', loading: 'Loading projects…' } },
    },
    resolve: (text) => resolveCentralInput(text, centralCommandList(src.centralEnabled, skills.last())),
  }
}
