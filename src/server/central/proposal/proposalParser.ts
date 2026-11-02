// B3 MVP deliberately uses assistant-text proposals instead of in-process MCP: the
// server remains the trust boundary and validates every block before any write.
export interface ProposalBlock { tool: string; input: Record<string, unknown> }
const OPEN = '<webterm-proposal>'
const CLOSE = '</webterm-proposal>'
const MAX_BLOCK = 16 * 1024
const MAX_BLOCKS = 4
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

function hasPrototypeKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => hasPrototypeKey(item, seen))
  return Object.entries(value).some(([key, child]) => FORBIDDEN.has(key) || hasPrototypeKey(child, seen))
}

export function parseProposals(text: string): ProposalBlock[] {
  const output: ProposalBlock[] = []
  let cursor = 0
  while (output.length < MAX_BLOCKS) {
    const start = text.indexOf(OPEN, cursor)
    if (start < 0) break
    const bodyStart = start + OPEN.length
    const end = text.indexOf(CLOSE, bodyStart)
    if (end < 0) break
    const raw = text.slice(bodyStart, end)
    cursor = end + CLOSE.length
    if (raw.length > MAX_BLOCK) continue
    try {
      const value = JSON.parse(raw) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value) || hasPrototypeKey(value)) continue
      const record = value as Record<string, unknown>
      if (typeof record.tool !== 'string' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input)) continue
      if (hasPrototypeKey(record.input)) continue
      output.push({ tool: record.tool, input: record.input as Record<string, unknown> })
    } catch {
      // Malformed assistant text is untrusted input and is ignored fail-closed.
    }
  }
  return output
}
