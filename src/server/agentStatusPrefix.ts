// Tolerant, bounded scan of a TRUNCATED hook body (agentStatusBody.ts): walks only the top-level
// keys of the JSON object and keeps the few small fields a status needs. No regex over raw text and
// no eval, so a quoted `"hook_event_name":"Stop"` inside a long message can never become a field.

const KEEP: ReadonlySet<string> = new Set([
  'hook_event_name', 'notification_type', 'error', 'error_details', 'session_id', 'stop_hook_active',
  'agent_id', 'transcript_path', 'message', 'tool_name', 'prompt', 'last_assistant_message',
])
const MESSAGE_KEY = 'last_assistant_message'
const SPACE = new Set([' ', '\t', '\n', '\r'])

interface Str { end: number; closed: boolean }

/** Finds the end of the JSON string whose opening quote is at `i`; `closed` false = text ran out first. */
function scanString(s: string, i: number): Str {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '"') return { end: j + 1, closed: true }
  }
  return { end: s.length, closed: false }
}

/** Skips one object/array starting at `i`; returns its end, or -1 when it is cut off. */
function skipNested(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '"') {
      const str = scanString(s, j)
      if (!str.closed) return -1
      j = str.end - 1
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return j + 1 }
  }
  return -1
}

/** Decodes the open string `raw` (no closing quote) after dropping an incomplete trailing escape. */
function decodeOpenString(raw: string): string | undefined {
  let t = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '')
  if ((t.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) t = t.slice(0, -1)
  try { return (JSON.parse(`"${t}"`) as string).replace(/�+$/, '') } catch { return undefined }
}

const parseString = (literal: string): string | undefined => {
  try { const v: unknown = JSON.parse(literal); return typeof v === 'string' ? v : undefined } catch { return undefined }
}

/**
 * Whitelisted top-level fields of a possibly cut-off hook body. A string cut by the end of the text
 * is dropped, except `last_assistant_message`, whose readable head is returned. Never throws.
 */
export function scanHookPrefix(s: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let i = 0
  const skip = (commas: boolean): void => { while (i < s.length && (SPACE.has(s[i] as string) || (commas && s[i] === ','))) i++ }
  skip(true)
  if (s[i] !== '{') return out
  i++
  for (;;) {
    skip(true)
    if (s[i] !== '"') return out
    const k = scanString(s, i)
    const key = k.closed ? parseString(s.slice(i, k.end)) : undefined
    if (key === undefined) return out
    i = k.end
    skip(false)
    if (s[i] !== ':') return out
    i++
    skip(false)
    const c = s[i]
    if (c === '"') {
      const v = scanString(s, i)
      if (!v.closed) {
        const head = key === MESSAGE_KEY ? decodeOpenString(s.slice(i + 1)) : undefined
        if (head) out[key] = head
        return out
      }
      const val = KEEP.has(key) ? parseString(s.slice(i, v.end)) : undefined
      if (val !== undefined) out[key] = val
      i = v.end
    } else if (c === '{' || c === '[') {
      const end = skipNested(s, i)
      if (end < 0) return out
      i = end
    } else {
      let j = i
      while (j < s.length && !SPACE.has(s[j] as string) && s[j] !== ',' && s[j] !== '}') j++
      if (j >= s.length) return out // literal may be cut mid-token
      const lit = s.slice(i, j)
      if (key === 'stop_hook_active' && (lit === 'true' || lit === 'false')) out[key] = lit === 'true'
      i = j
    }
  }
}
