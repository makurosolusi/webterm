export interface VisibleProposal {
  tool: string
  projectId?: string
  itemId?: string
  raw: string
}

const OPEN = '<webterm-proposal>'
const CLOSE = '</webterm-proposal>'
const MAX_BLOCKS = 4

export function splitProposalBlocks(text: string): { visible: string; proposals: VisibleProposal[] } {
  const visible: string[] = []
  const proposals: VisibleProposal[] = []
  let cursor = 0

  while (proposals.length < MAX_BLOCKS) {
    const start = text.indexOf(OPEN, cursor)
    if (start < 0) break
    const bodyStart = start + OPEN.length
    const end = text.indexOf(CLOSE, bodyStart)
    if (end < 0) break
    visible.push(text.slice(cursor, start))
    const raw = text.slice(start, end + CLOSE.length)
    const body = text.slice(bodyStart, end)
    cursor = end + CLOSE.length
    try {
      const value = JSON.parse(body) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        visible.push(raw)
        continue
      }
      const record = value as Record<string, unknown>
      if (typeof record.tool !== 'string' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input)) {
        visible.push(raw)
        continue
      }
      const input = record.input as Record<string, unknown>
      proposals.push({
        tool: record.tool,
        ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}),
        ...(typeof input.itemId === 'string' ? { itemId: input.itemId } : {}),
        raw,
      })
    } catch {
      visible.push(raw)
    }
  }

  visible.push(text.slice(cursor))
  return { visible: visible.join('').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n'), proposals }
}
