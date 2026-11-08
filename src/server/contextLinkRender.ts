// Pure render/format helpers for the context-link backend (no fs, no db).
// Split out of `contextLink.ts` to keep each module under the file-health budget.

export type ContextLinkVerb = 'list' | 'summary' | 'transcript' | 'terminal'
export const CONTEXT_LINK_VERBS: ContextLinkVerb[] = ['list', 'summary', 'transcript', 'terminal']
/** `name` = the node's unique handle ("Kiwi", see shared/nodeNames); absent on boards read without names. */
export interface LinkDocEntry { id: string; name?: string; title: string; agent?: string; sessionId?: string }
export interface LinkDoc { links: LinkDocEntry[] }

const SUMMARY_DEFAULT_LINES = 15

// --- node selection + render strings (ported verbatim, minus the note branch) ---

/** `Kiwi "Build log"` when the node has a name, else the bare title (the pre-name output). */
const label = (n: LinkDocEntry): string => (n.name ? `${n.name} "${n.title}"` : n.title)

export function pickLinkNode(doc: LinkDoc, want?: string): { node: LinkDocEntry } | { message: string } {
  const links = doc.links
  if (!links.length) return { message: 'No linked nodes. Draw a context-link edge from this node to another on the canvas.' }
  if (want) {
    const q = want.toLowerCase()
    // Id first, then name, then title: a title may happen to equal another node's name or id.
    const m = links.find((n) => n.id.toLowerCase() === q)
      ?? links.find((n) => (n.name || '').toLowerCase() === q)
      ?? links.find((n) => (n.title || '').toLowerCase() === q)
    if (!m) return { message: `No linked node matches "${want}". Linked: ${links.map(label).join(', ')}` }
    return { node: m }
  }
  if (links.length === 1) return { node: links[0] }
  return { message: ['Several linked nodes — re-run with --node <name|id|title>:', ...links.map((n) => `- ${label(n)} (id: ${n.id})`)].join('\n') }
}

export function renderList(doc: LinkDoc): string {
  if (!doc.links.length) return 'No linked nodes.'
  return ['Linked nodes:', ...doc.links.map((n) => `- ${label(n)} (id: ${n.id})`)].join('\n')
}

export function renderSummary(node: LinkDocEntry, lines: string[], n: number): string {
  return [`=== ${label(node)} — last ${n} lines ===`, ...lines.slice(-n)].join('\n')
}

export function renderFullTranscript(node: LinkDocEntry, lines: string[]): string {
  return [`=== ${label(node)} — full transcript (${lines.length} lines) ===`, ...lines].join('\n')
}

export function renderTerminal(node: LinkDocEntry, capture: string): string {
  const body = capture.replace(/\s+$/, '')
  return [`=== ${label(node)} — terminal ===`, body || `"${node.title}" terminal session is not running.`].join('\n')
}

export function parseSummaryCount(raw: string | undefined): number {
  const n = parseInt(raw || '', 10)
  return Number.isFinite(n) && n > 0 ? n : SUMMARY_DEFAULT_LINES
}

// Strip CSI + OSC escapes so a reading agent sees text, not control codes.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '')
}
