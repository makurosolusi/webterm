// What the omnibox lists for a query — pure, so ranking and sources are testable without DOM.
// Prefixes follow VS Code Quick Open: `>` commands, `%` text search (quick search), none = every
// source on ⌘K (Orca Jump palette mixes worktrees/tabs/files the same way) or files only on ⌘P.
import { targetScore, type PaletteTarget } from './paletteTargets'
import { rankWithHistory } from './QuickOpen.recency'
import type { GrepMatch } from './QuickOpen.grep'
import { maskLine } from './secretMask.surfaces'
import type { RecentItem } from './browser.recent'

export type OmniScope = 'all' | 'files'
export type OmniAction =
  | { kind: 'node'; id: string }
  | { kind: 'command'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'url'; url: string }
  | { kind: 'plan'; intent: string }
  | { kind: 'file'; rel: string; line?: number; col?: number }
  | { kind: 'more' }

export interface OmniItem {
  id: string
  label: string
  description?: string
  keybinding?: string
  /** Codicon name. */
  icon: string
  group: string
  action: OmniAction
}

export interface OmniSources {
  nodes: PaletteTarget[]
  commands: { id: string; label: string; keybinding?: string }[]
  agents: { id: string; label: string }[]
  recentUrls: RecentItem[]
  /** Workspace files, relative to its cwd. */
  files: readonly string[]
  /** Recently opened files, relative to the same cwd, newest first. */
  recentFiles: readonly string[]
  /** Typed text → browser URL when it reads as an address (not a web search), else null. */
  asUrl: (q: string) => string | null
}

export const COMMAND_PREFIX = '>'
export const SEARCH_PREFIX = '%'
/** Rows per group; files get more room when they are the whole list (⌘P). */
export const GROUP_CAP = { nodes: 20, commands: 40, agents: 20, urls: 6, files: 8, filesOnly: 50 }

/** Longest intent a Plan row carries (server `INTENT_MAX`). */
export const INTENT_MAX = 2000
/** A typed phrase (two words or more) reads as an intent that can be planned; one word stays a lookup. */
export const isIntent = (q: string): boolean => /\S\s+\S/.test(q) && q.length <= INTENT_MAX

export type OmniMode = 'mixed' | 'files' | 'commands' | 'search'
export function omniMode(query: string, scope: OmniScope): OmniMode {
  if (query.startsWith(COMMAND_PREFIX)) return 'commands'
  if (query.startsWith(SEARCH_PREFIX)) return 'search'
  return scope === 'files' ? 'files' : 'mixed'
}
/** Query without its mode prefix, trimmed. */
export const omniNeedle = (query: string): string => query.replace(/^[>%]/, '').trim()

/** Best-first by the palette scorer, capped; declaration order breaks ties. */
function ranked<T>(list: T[], q: string, cap: number, target: (t: T) => PaletteTarget): T[] {
  const scored = list.map((t, i) => ({ t, i, s: targetScore(target(t), q) })).filter((r) => r.s !== null)
  scored.sort((a, b) => (a.s as number) - (b.s as number) || a.i - b.i)
  return scored.slice(0, cap).map((r) => r.t)
}

function fileItems(q: string, src: OmniSources, cap: number): OmniItem[] {
  return rankWithHistory(q, src.files, src.recentFiles, cap).map((rel) => {
    const slash = rel.lastIndexOf('/')
    return {
      id: `file:${rel}`, label: rel.slice(slash + 1), description: slash > 0 ? rel.slice(0, slash) : undefined,
      icon: 'file', group: src.recentFiles.includes(rel) ? 'Recently opened' : 'Files', action: { kind: 'file', rel },
    }
  })
}

function commandItems(q: string, src: OmniSources): OmniItem[] {
  return ranked(src.commands, q, GROUP_CAP.commands, (c) => ({ id: c.id, label: c.label })).map((c) => ({
    id: `command:${c.id}`, label: c.label, keybinding: c.keybinding, icon: 'symbol-event', group: 'Commands', action: { kind: 'command', id: c.id },
  }))
}

/** Items for `query` (prefix included) in `scope`. Text search results come from `searchItems`. */
export function omniboxItems(query: string, scope: OmniScope, src: OmniSources): OmniItem[] {
  const mode = omniMode(query, scope)
  const q = omniNeedle(query)
  if (mode === 'commands') return commandItems(q, src)
  if (mode === 'search') return []
  if (mode === 'files') return fileItems(q, src, GROUP_CAP.filesOnly)

  const url = q ? src.asUrl(q) : null
  return [
    ...(url ? [{ id: 'url:typed', label: `Open ${url} in Browser`, icon: 'globe', group: 'Browser', action: { kind: 'url', url } } satisfies OmniItem] : []),
    ...ranked(src.nodes, q, GROUP_CAP.nodes, (n) => n).map((n): OmniItem => ({
      id: `node:${n.id}`, label: n.label, description: n.hint, icon: 'symbol-namespace', group: 'Nodes', action: { kind: 'node', id: n.id },
    })),
    // F4-f: drafts a DAG for review on the canvas; nothing runs until the plan is approved.
    ...(isIntent(q) ? [{ id: 'plan:typed', label: `Plan: ${q}`, description: 'Draft tasks for review, nothing runs yet', icon: 'type-hierarchy', group: 'Plan', action: { kind: 'plan', intent: q } } satisfies OmniItem] : []),
    ...(q ? fileItems(q, src, GROUP_CAP.files) : []),
    ...ranked(src.agents, q, GROUP_CAP.agents, (a) => ({ id: a.id, label: `New ${a.label} agent` })).map((a): OmniItem => ({
      id: `agent:${a.id}`, label: `New ${a.label} agent`, icon: 'hubot', group: 'Agents', action: { kind: 'agent', id: a.id },
    })),
    ...ranked(src.recentUrls, q, GROUP_CAP.urls, (r) => ({ id: r.url, label: r.title || r.host, hint: r.url })).map((r): OmniItem => ({
      id: `url:${r.url}`, label: r.title || r.host, description: r.url, icon: 'globe', group: 'Browser', action: { kind: 'url', url: r.url },
    })),
    ...commandItems(q, src),
  ]
}

/** Text search matches as rows, plus a "Load more" row while the server has another page. */
export function searchItems(matches: readonly GrepMatch[], hasMore: boolean, maskSecrets = false): OmniItem[] {
  // With `maskSecrets` the row text hides secret values; the match itself (file:line, col) stays listed.
  const rows = matches.map((m, i): OmniItem => ({
    id: `match:${i}:${m.file}:${m.line}`, label: (maskSecrets ? maskLine(m.file, m.text) : m.text).trim() || '(blank line)', description: `${m.file}:${m.line}`,
    icon: 'search', group: 'Results', action: { kind: 'file', rel: m.file, line: m.line, col: m.col },
  }))
  return hasMore ? [...rows, { id: 'more', label: 'Load more results…', icon: 'ellipsis', group: 'Results', action: { kind: 'more' } }] : rows
}
