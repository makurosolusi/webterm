// Pure decisions behind the composer's completion menu, ported from nodeterm
// (renderer/lib/chatComposerComplete.ts + shared/chat-catalog.ts): which token the caret is in
// (`/command` at the start of the message, `@path` at the start of any word), how a list is ranked,
// and what accepting an item does to the draft. Accepting only INSERTS text; sending stays the
// composer's own Enter. `agentChatCompletion` is the factory the Agent Chat node passes to ChatComposer;
// the Central chat builds its own `ComposerCompletion` (central/centralCommands) on the same pieces.
import { AGENT_CHAT_FALLBACK_COMMANDS, type AgentChatCommand } from '../../shared/agentChat.wire'
import { fuzzyFilter } from '../fuzzy'

export type CompletionKind = 'slash' | 'file'

export interface CompletionTrigger {
  kind: CompletionKind
  /** What the user typed after the `/` or `@`. */
  query: string
  /** Offsets of the whole token (the `/` or `@` included) in the draft. */
  start: number
  end: number
}

export interface CompletionItem {
  /** Inserted after the `/` or `@`: a command name, or a path relative to the node's folder. */
  value: string
  description?: string
  argumentHint?: string
  /** Short source tag shown at the right ("built-in", "custom", "MCP", "folder"). */
  badge?: string
  /** A folder: accepting inserts `dir/` and keeps the menu open to drill in. */
  dir?: boolean
}

/** The menu's words for one kind of token. */
export interface CompletionKindText { label: string; empty: string; loading: string }

/** What a composer needs to complete: the items for a trigger (sync or async; a rejection is shown as an error). */
export interface ComposerCompletion {
  provider: (trigger: CompletionTrigger) => CompletionItem[] | Promise<CompletionItem[]>
  /** Menu wording per kind when the source is not commands/files (e.g. `@` lists projects). */
  text?: Partial<Record<CompletionKind, CompletionKindText>>
}

/** What `rankCommands` needs of a command: Agent Chat's catalog entries and Central's table both fit. */
export interface RankableCommand { name: string; description: string; aliases?: readonly string[] }

const NAME_CHAR = /[A-Za-z0-9._:-]/

/**
 * The token the caret is in, or null. `/x` is a command only at the very start of the message (after
 * optional whitespace), like Claude Code, so `see /usr` never opens the menu. `@` opens it at the start
 * of a word only, so an e-mail address (`a@b`) does not. A selection never completes.
 */
export function completionTriggerAt(text: string, caret: number, selectionEnd = caret): CompletionTrigger | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  const slash = /^(\s*)\/([A-Za-z0-9._:-]*)$/.exec(before)
  if (slash) {
    let end = caret
    while (end < text.length && NAME_CHAR.test(text[end])) end++
    return { kind: 'slash', query: slash[2], start: slash[1].length, end }
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) {
    const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? ''
    return { kind: 'file', query: at[2], start: caret - at[2].length - 1, end: caret + rest.length }
  }
  return null
}

/**
 * Accepting `item`: the token becomes `/name ` or `@path ` and the caret lands after it (no second
 * space when one already follows). A folder becomes `@dir/` with no space, so the caret stays in the
 * token and the menu keeps listing what is inside it.
 */
export function applyCompletion(text: string, t: CompletionTrigger, item: CompletionItem): { text: string; caret: number } {
  const next = text.slice(t.end)
  if (t.kind === 'file' && item.dir) {
    const token = `@${item.value.replace(/\/*$/, '/')}`
    return { text: text.slice(0, t.start) + token + next, caret: t.start + token.length }
  }
  const token = (t.kind === 'slash' ? '/' : '@') + item.value
  const insert = /^\s/.test(next) ? token : `${token} `
  return { text: text.slice(0, t.start) + insert + next, caret: t.start + insert.length }
}

export const COMMAND_RESULT_LIMIT = 50
export const FILE_RESULT_LIMIT = 30

/**
 * The `/` list for a query: prefix matches (name or alias) first, then names containing the query,
 * then description-only matches (3+ chars); within a band shorter names first, then alphabetical.
 * Case-insensitive; an empty query lists everything in that order.
 */
export function rankCommands<C extends RankableCommand>(commands: readonly C[], query: string, limit = COMMAND_RESULT_LIMIT): C[] {
  const q = query.toLowerCase()
  const scored: { c: C; band: number }[] = []
  for (const c of commands) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
    let band: number
    if (!q || names.some((n) => n.startsWith(q))) band = 0
    else if (names.some((n) => n.includes(q))) band = 1
    else if (q.length >= 3 && c.description.toLowerCase().includes(q)) band = 2
    else continue
    scored.push({ c, band })
  }
  scored.sort((a, b) => a.band - b.band || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
  return scored.slice(0, limit).map((s) => s.c)
}

/** Source tag of a command. MCP prompts reach the SDK as `mcp__server__prompt`. */
export function commandBadge(c: AgentChatCommand): string {
  if (c.builtin) return 'built-in'
  return c.name.startsWith('mcp__') ? 'MCP' : 'custom'
}

export interface FileEntry { path: string; dir: boolean }

// Whitespace, control and format characters: `@a b.md` would read as `@a` plus a word, and a control
// byte in a name is a sequence, not a name. Such paths are not offered.
const UNTYPEABLE = /[\s\x00-\x1f\x7f-\x9f\p{Cf}]/u

/** Each file's parent folders, so `@` can drill into a folder even when the source lists files only. */
export function withParentDirs(entries: readonly FileEntry[]): FileEntry[] {
  const dirs = new Set(entries.filter((e) => e.dir).map((e) => e.path.replace(/\/+$/, '')))
  const out = [...entries]
  for (const e of entries) {
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (d && !dirs.has(d)) { dirs.add(d); out.push({ path: d, dir: true }) }
    }
  }
  return out
}

/** The `@` list: the same fuzzy ranker as Quick Open; unsafe or untypeable paths are left out. */
export function rankFiles(entries: readonly FileEntry[], query: string, limit = FILE_RESULT_LIMIT): FileEntry[] {
  const byPath = new Map<string, FileEntry>()
  for (const e of entries) {
    const path = e.path.replace(/\/+$/, '')
    if (!path || UNTYPEABLE.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue
    byPath.set(path, { path, dir: e.dir })
  }
  // A drill-in query (`src/`) lists that folder's children, not every fuzzy hit of "src/".
  const pool = query.endsWith('/') ? [...byPath.keys()].filter((p) => p.startsWith(query)) : [...byPath.keys()]
  const q = query.endsWith('/') ? '' : query
  return fuzzyFilter(q, pool, limit).map((p) => byPath.get(p)!)
}

/**
 * Built-ins offered when the server catalog is empty or failed: the server's own fallback list
 * (`GET catalog` answers 409/503 with it), so the client never shows a second, different list.
 */
export const FALLBACK_COMMANDS: readonly AgentChatCommand[] = AGENT_CHAT_FALLBACK_COMMANDS

/** How long a loaded catalog is reused before the next `/` asks again (not a poll: only typing asks). */
export const CATALOG_REUSE_MS = 30_000

export interface AgentChatCompletionSources {
  loadCommands: () => Promise<AgentChatCommand[]>
  /** Called with the typed query on each change; may return the whole index, the result is ranked here. */
  searchFiles: (query: string) => Promise<FileEntry[]>
  /** Commands the host answers itself (e.g. `/model`), added to the catalog or the fallback unless already listed. */
  localCommands?: readonly AgentChatCommand[]
}

/** Completion for the Agent Chat composer: `/` lists Claude Code commands, `@` lists files and folders. */
export function agentChatCompletion(src: AgentChatCompletionSources, now: () => number = Date.now): ComposerCompletion {
  let catalog: { at: number; list: Promise<AgentChatCommand[]> } | null = null
  const withLocal = (l: AgentChatCommand[]): AgentChatCommand[] =>
    [...l, ...(src.localCommands ?? []).filter((c) => !l.some((x) => x.name === c.name))]
  const commands = (): Promise<AgentChatCommand[]> => {
    if (!catalog || now() - catalog.at > CATALOG_REUSE_MS) {
      // A failed or empty catalog falls back to the built-ins, and is asked again on the next `/`.
      const list = src.loadCommands().then(
        (l) => { if (!l.length) catalog = null; return withLocal(l.length ? l : [...FALLBACK_COMMANDS]) },
        () => { catalog = null; return withLocal([...FALLBACK_COMMANDS]) },
      )
      catalog = { at: now(), list }
      return list
    }
    return catalog.list
  }
  return {
    provider: async (t) => {
      if (t.kind === 'slash') {
        return rankCommands(await commands(), t.query).map((c) => ({
          value: c.name, description: c.description, argumentHint: c.argumentHint, badge: commandBadge(c),
        }))
      }
      const files = await src.searchFiles(t.query)
      return rankFiles(withParentDirs(files), t.query).map((f) => ({ value: f.path, dir: f.dir, ...(f.dir ? { badge: 'folder' } : {}) }))
    },
  }
}
