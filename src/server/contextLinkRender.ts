// Text rendering for the read-only context-link backend: pure functions, no fs, no db.
// Each reply is plain text meant to be read by another agent, so headers are one `=== … ===` line.

export type ContextLinkVerb = 'list' | 'summary' | 'transcript' | 'terminal'
export const CONTEXT_LINK_VERBS: ContextLinkVerb[] = ['list', 'summary', 'transcript', 'terminal']

/** A linked node; `name` is its unique handle (see shared/nodeNames), absent on boards read without names. */
export interface LinkDocEntry { id: string; name?: string; title: string; agent?: string; sessionId?: string }
export interface LinkDoc { links: LinkDocEntry[] }

/** How many trailing lines `summary` returns when the caller gives no usable count. */
const DEFAULT_SUMMARY_LINES = 15

const NO_LINKS_HINT = 'No linked nodes. Draw a context-link edge from this node to another on the canvas.'

/** Human label: `Kiwi "Build log"` for a named node, the bare title otherwise. */
const labelOf = (entry: LinkDocEntry): string => (entry.name ? `${entry.name} "${entry.title}"` : entry.title)

const bulletOf = (entry: LinkDocEntry): string => `- ${labelOf(entry)} (id: ${entry.id})`

const banner = (entry: LinkDocEntry, what: string): string => `=== ${labelOf(entry)} — ${what} ===`

/** Resolve which linked node a request means: by id, then name, then title (case-insensitive); the only link when unspecified. */
export function pickLinkNode(doc: LinkDoc, want?: string): { node: LinkDocEntry } | { message: string } {
  const { links } = doc
  if (links.length === 0) return { message: NO_LINKS_HINT }
  if (!want) {
    if (links.length === 1) return { node: links[0] }
    return { message: ['Several linked nodes — re-run with --node <name|id|title>:', ...links.map(bulletOf)].join('\n') }
  }
  const needle = want.toLowerCase()
  // Order matters: a title may coincide with another node's name or id, and ids are the most specific.
  const keys: ((e: LinkDocEntry) => string)[] = [(e) => e.id, (e) => e.name || '', (e) => e.title || '']
  for (const key of keys) {
    const hit = links.find((e) => key(e).toLowerCase() === needle)
    if (hit) return { node: hit }
  }
  return { message: `No linked node matches "${want}". Linked: ${links.map(labelOf).join(', ')}` }
}

/** The `list` verb: one bullet per linked node. */
export function renderList(doc: LinkDoc): string {
  if (doc.links.length === 0) return 'No linked nodes.'
  return ['Linked nodes:', ...doc.links.map(bulletOf)].join('\n')
}

/** The `summary` verb: the last `count` lines of the transcript. */
export function renderSummary(node: LinkDocEntry, lines: string[], count: number): string {
  return [banner(node, `last ${count} lines`), ...lines.slice(-count)].join('\n')
}

/** The `transcript` verb: every line, with the total in the header. */
export function renderFullTranscript(node: LinkDocEntry, lines: string[]): string {
  return [banner(node, `full transcript (${lines.length} lines)`), ...lines].join('\n')
}

/** The `terminal` verb: trailing whitespace trimmed, or a not-running notice when nothing was captured. */
export function renderTerminal(node: LinkDocEntry, capture: string): string {
  const text = capture.trimEnd()
  return [banner(node, 'terminal'), text || `"${node.title}" terminal session is not running.`].join('\n')
}

/** Parse a `--lines` value; anything that is not a positive integer falls back to the default. */
export function parseSummaryCount(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return n > 0 ? n : DEFAULT_SUMMARY_LINES
}

const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_SEQUENCE = /\x1b[[0-9;?]*[ -/]*[@-~]/g

/** Remove OSC and CSI escape sequences so a reading agent sees text, not control codes. */
export function stripAnsi(s: string): string {
  return s.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '')
}
