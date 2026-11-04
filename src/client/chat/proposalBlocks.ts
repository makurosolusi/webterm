/** A `<webterm-proposal>` block from chat history written before Central moved to native tool calls; shown, never run. */
export interface LegacyProposal {
  tool: string
  body: string
}

const OPEN = '<webterm-proposal>'
const CLOSE = '</webterm-proposal>'
const MAX_BLOCKS = 4

/** Splits well-formed legacy blocks out of assistant text; malformed ones stay in the visible text. */
export function splitProposalBlocks(text: string): { visible: string; proposals: LegacyProposal[] } {
  const visible: string[] = []
  const proposals: LegacyProposal[] = []
  let cursor = 0

  while (proposals.length < MAX_BLOCKS) {
    const start = text.indexOf(OPEN, cursor)
    if (start < 0) break
    const bodyStart = start + OPEN.length
    const end = text.indexOf(CLOSE, bodyStart)
    if (end < 0) break
    visible.push(text.slice(cursor, start))
    const body = text.slice(bodyStart, end)
    cursor = end + CLOSE.length
    const tool = toolOf(body)
    if (tool === null) visible.push(text.slice(start, cursor))
    else proposals.push({ tool, body })
  }

  visible.push(text.slice(cursor))
  return { visible: visible.join('').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n'), proposals }
}

function toolOf(body: string): string | null {
  try {
    const value = JSON.parse(body) as { tool?: unknown } | null
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.tool === 'string' ? value.tool : null
  } catch {
    return null
  }
}
