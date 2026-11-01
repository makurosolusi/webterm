// Pure render/format helpers for the context-link backend (no fs, no db).
// Split out of `contextLink.ts` to keep each module under the file-health budget.

export type ContextLinkVerb = 'list' | 'summary' | 'transcript' | 'terminal'
export const CONTEXT_LINK_VERBS: ContextLinkVerb[] = ['list', 'summary', 'transcript', 'terminal']
export interface LinkDocEntry { id: string; title: string; agent?: string; sessionId?: string }
export interface LinkDoc { links: LinkDocEntry[] }

const SUMMARY_DEFAULT_LINES = 15

// --- node selection + render strings (ported verbatim, minus the note branch) ---

export function pickLinkNode(doc: LinkDoc, want?: string): { node: LinkDocEntry } | { message: string } {
  const links = doc.links
  if (!links.length) return { message: 'No linked nodes. Draw a context-link edge from this node to another on the canvas.' }
  if (want) {
    const q = want.toLowerCase()
    const m = links.find((n) => n.id.toLowerCase() === q || (n.title || '').toLowerCase() === q)
    if (!m) return { message: `No linked node matches "${want}". Linked: ${links.map((n) => n.title).join(', ')}` }
    return { node: m }
  }
  if (links.length === 1) return { node: links[0] }
  return { message: ['Several linked nodes — re-run with --node <id|title>:', ...links.map((n) => `- ${n.title} (id: ${n.id})`)].join('\n') }
}

export function renderList(doc: LinkDoc): string {
  if (!doc.links.length) return 'No linked nodes.'
  return ['Linked nodes:', ...doc.links.map((n) => `- ${n.title} (id: ${n.id})`)].join('\n')
}

export function renderSummary(node: LinkDocEntry, lines: string[], n: number): string {
  return [`=== ${node.title} — last ${n} lines ===`, ...lines.slice(-n)].join('\n')
}

export function renderFullTranscript(node: LinkDocEntry, lines: string[]): string {
  return [`=== ${node.title} — full transcript (${lines.length} lines) ===`, ...lines].join('\n')
}

export function renderTerminal(node: LinkDocEntry, capture: string): string {
  const body = capture.replace(/\s+$/, '')
  return [`=== ${node.title} — terminal ===`, body || `"${node.title}" terminal session is not running.`].join('\n')
}

export function parseSummaryCount(raw: string | undefined): number {
  const n = parseInt(raw || '', 10)
  return Number.isFinite(n) && n > 0 ? n : SUMMARY_DEFAULT_LINES
}

// Strip CSI + OSC escapes so a reading agent sees text, not control codes.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '')
}
