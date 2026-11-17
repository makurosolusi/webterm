// Deterministic intent hint (no model call): a human message that reads like a playbook's job gets a
// `Suggested playbook:` line in the volatile prompt tail, so Central runs the whole chain in one tool call
// instead of rebuilding it from memory. English and Indonesian words; chit-chat matches nothing.
import { PLAYBOOKS, playbookTool } from '../playbooks/playbook.defs'
import { SKILL_REQUEST_WORDS } from '../playbooks/playbook.intentWords'

export interface PlaybookMatch { id: string; tool: string; args: Record<string, string> }

const MAX_GOAL = 300
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i
/** Bare domains such as `github.com/trending`; the TLD list stays short to keep false hits rare. */
const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|id|co|app)(?:\/[^\s<>"')]*)?)/i
/** Well-known pages people name without a URL. */
const KNOWN_PAGES: ReadonlyArray<[RegExp, string]> = [
  [/\bgithub\s+trending\b/i, 'https://github.com/trending'],
  [/\bhacker\s*news\b/i, 'https://news.ycombinator.com'],
  [/\bproduct\s*hunt\b/i, 'https://www.producthunt.com'],
]

/** The URL a message names: explicit, a known page, or a bare domain. */
export function urlOf(text: string): string | null {
  const explicit = text.match(URL_RE)?.[0]
  if (explicit) return explicit.replace(/[.,;:!?]+$/, '')
  const known = KNOWN_PAGES.find(([re]) => re.test(text))
  if (known) return known[1]
  const bare = text.match(DOMAIN_RE)?.[1]
  return bare ? `https://${bare.replace(/[.,;:!?]+$/, '')}` : null
}

/** A research ask this short with one link is usually a single page or search, which `browser_read` covers. */
const SHORT_ASK = 200
const BROWSER_READ = 'browser_read'
const PAGE_NOTE = 'For ONE page or ONE search, browser_read fits better than a worker.'

const goalOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL)

/** First playbook whose words match (priority = PLAYBOOKS order); a bare URL matches none (see `playbookHintLine`). */
export function matchPlaybook(text: string): PlaybookMatch | null {
  // A skill request is no worker job (a worker must never write a Central skill): no playbook, so "ubah skill ..." is not a code_change.
  if (SKILL_REQUEST_WORDS.test(text)) return null
  const url = urlOf(text)
  const hit = PLAYBOOKS.find((pb) => pb.match.some((re) => re.test(text)))
  if (!hit) return null
  const goal = goalOf(text)
  const args: Record<string, string> = hit.subject === 'target' ? { target: url ?? goal } : { goal }
  if (hit.id === 'web_research' && url) args.url = url
  return { id: hit.id, tool: playbookTool(hit.id), args }
}

/** Where the user turns workers on; named in the line Central relays when a playbook is missing. */
export const WORKERS_SETTING = 'Settings › Central › What Central may do'

/**
 * The prompt line for `text`, or '' when nothing matches. `usable` says whether the tool exists this turn:
 * when it does not (agents off), the line says why instead of suggesting a tool Central cannot call.
 */
export function playbookHintLine(text: string, usable: (tool: string) => boolean): string {
  const m = matchPlaybook(text)
  if (!m) {
    // A lone link needs no worker: read the page directly, and say nothing when that tool is unavailable.
    const url = urlOf(text)
    return url && usable(BROWSER_READ) ? `Suggested tool: ${BROWSER_READ} ${JSON.stringify({ url })}` : ''
  }
  if (usable(m.tool)) {
    const note = m.id === 'web_research' && m.args.url && text.length <= SHORT_ASK && usable(BROWSER_READ) ? ` ${PAGE_NOTE}` : ''
    return `Suggested playbook: ${m.tool} ${JSON.stringify(m.args)}${note}`
  }
  const label = PLAYBOOKS.find((pb) => pb.id === m.id)?.label ?? m.id
  return `This looks like ${m.id === 'web_research' ? label : `a ${label}`}, but workers are off (${WORKERS_SETTING})`
}
