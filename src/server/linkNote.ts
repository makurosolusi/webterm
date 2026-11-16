// The VISIBLE link note: the one-line `[webterm] …` prompt typed into a Claude Code node's input box
// when a cable to it is drawn, removed, or the node at its other end is renamed. Wording: "[webterm] You are now linked to
// …. No action needed now — just acknowledge briefly.". The hidden `additionalContext` of
// `hookContext`/`linkAwareness` stays as the fallback; `linkNoteDelivery` marks both delivered so the
// same change is never announced twice.
//
// Pure: what the node is wired to now, and the note for the change from what it was last told.
import type { Workspace } from '../shared/workspace'
import { buildLinkDoc, SKILL_NAME } from './contextLink'
import { BROWSER_SKILL_NAME } from './browserAgentShim'
import { linkedBrowsers } from './linkAwareness'

/** One node at the other end of a cable. `browser` = a browser node (a tool), else a context peer. */
export interface LinkEntry { id: string; name?: string; title: string; browser: boolean }

/** Everything wired to `nodeId` right now: browser nodes and context-link peers. */
export function linkEntries(ws: Workspace, nodeId: string): LinkEntry[] {
  return [
    ...linkedBrowsers(ws, nodeId).map((b) => ({ id: b.id, name: b.name, title: b.title, browser: true })),
    ...buildLinkDoc(ws, nodeId).links.map((p) => ({ id: p.id, name: p.name, title: p.title, browser: false })),
  ]
}

const TITLE_MAX_CHARS = 120

/**
 * SECURITY: a title is user/agent-settable text quoted into a line that gets SUBMITTED in an agent
 * session, so it must stay ONE line of plain text.
 * Every control, format and line/paragraph separator (CR, LF, ESC, U+2028, …) becomes a space.
 */
export function oneLine(s: string): string {
  const flat = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS)}…` : flat
}

/** `Kiwi "title" (id x)`; the name is left out when the node has none. */
const nameOf = (e: LinkEntry): string => (e.name ? `${oneLine(e.name)} ` : '')
const q = (e: LinkEntry): string => `${nameOf(e)}"${oneLine(e.title) || e.id}" (id ${oneLine(e.id)})`

function sentence(kind: 'added' | 'removed' | 'renamed', e: LinkEntry): string {
  if (e.browser) {
    if (kind === 'added') return `The user wired browser node ${q(e)} to you, giving you this browser to use for the tasks they ask; drive it with the ${BROWSER_SKILL_NAME} skill.`
    if (kind === 'removed') return `Browser node ${q(e)} was unwired from you; you can no longer drive it.`
    return `The wired browser node ${nameOf(e)}(id ${oneLine(e.id)}) is now titled "${oneLine(e.title)}".`
  }
  if (kind === 'added') return `You are now linked to ${q(e)}; use the ${SKILL_NAME} skill to read its context when you need it.`
  if (kind === 'removed') return `You are no longer linked to ${q(e)}.`
  return `The linked node ${nameOf(e)}(id ${oneLine(e.id)}) is now titled "${oneLine(e.title)}".`
}

/**
 * The note for the NET change `prev` → `now`, or null when nothing changed. Diffing against what was
 * last told (not against each edit) is what coalesces: wire + unwire before delivery = no note.
 * Self-defusing: it is submitted as a prompt, so it says "No action needed now".
 */
export function buildLinkNote(prev: readonly LinkEntry[], now: readonly LinkEntry[]): string | null {
  const before = new Map(prev.map((e) => [e.id, e]))
  const after = new Map(now.map((e) => [e.id, e]))
  const parts: string[] = []
  for (const e of now) {
    const old = before.get(e.id)
    if (!old || old.browser !== e.browser) parts.push(sentence('added', e))
    else if (old.title !== e.title) parts.push(sentence('renamed', e))
  }
  for (const e of prev) if (after.get(e.id)?.browser !== e.browser) parts.push(sentence('removed', e))
  if (!parts.length) return null
  return `[webterm] ${parts.join(' ')} No action needed now — just acknowledge briefly.`
}
