// Reads a Claude Code session transcript (~/.claude/projects/<project>/<session-id>.jsonl) and
// flattens it to display lines for the read-only context-link backend.
// Entry shape used here: one JSON object per line, `{ type: 'user' | 'assistant', message: { content } }`
// where `content` is a plain string or an array of blocks (`text`, `tool_use`, `tool_result`).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { transcriptPathAllowed } from './transcriptPath'

const TOOL_INPUT_PREVIEW_CHARS = 200
const TOOL_OUTPUT_PREVIEW_CHARS = 500
const TOOL_OUTPUT_PREVIEW_LINES = 3
/** A transcript grows without bound; a reader only needs the newest tail of the conversation. */
const TAIL_BYTES = 4 * 1024 * 1024

/**
 * Return the last `TAIL_BYTES` of a transcript as text, or null when it must not be read.
 * The file is agent-owned and can be swapped after its path was validated, so: lstat rejects
 * symlinks/FIFOs/devices, realpath must stay inside the allowed roots, and O_NOFOLLOW closes the
 * gap between those two syscalls. The size cap keeps a huge file from stalling the event loop.
 */
export function readTranscriptFile(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null
    const resolved = realpathSync(path)
    if (!transcriptPathAllowed(resolved)) return null
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return null
      const offset = Math.max(0, st.size - TAIL_BYTES)
      const want = st.size - offset
      if (want <= 0) return ''
      const chunk = Buffer.alloc(want)
      readSync(fd, chunk, 0, want, offset)
      return chunk.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }

/** Safe JSON.parse for one line; a truncated or corrupt line yields undefined. */
function tryParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A tool_result payload is either a string or an array of parts; join the text parts. */
function flattenResult(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!Array.isArray(payload)) return ''
  const texts: string[] = []
  for (const part of payload as Block[]) {
    if (part?.type === 'text' && part.text) texts.push(part.text)
  }
  return texts.join('\n')
}

/** The most telling single argument of a tool call, as a short ` <arg>` suffix ('' when none). */
function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'description', 'prompt']) {
    const v = o[key]
    if (v !== undefined && v !== null) {
      return typeof v === 'string' ? ` ${v.slice(0, TOOL_INPUT_PREVIEW_CHARS)}` : ''
    }
  }
  return ''
}

/** One transcript JSONL line -> zero or more display strings. */
export function linesFromClaude(raw: string): string[] {
  const entry = tryParse(raw) as { type?: string; message?: { content?: unknown } } | undefined
  if (!entry) return []
  const content = entry.message?.content
  if (entry.type === 'user' && typeof content === 'string') return [`user: ${content}`]
  if (!Array.isArray(content)) return []

  const out: string[] = []
  for (const block of content as Block[]) {
    if (entry.type === 'assistant') {
      if (block.type === 'text' && block.text) out.push(`assistant: ${block.text}`)
      else if (block.type === 'tool_use') out.push(`  $ ${block.name || 'tool'}${describeToolInput(block.input)}`)
    } else if (entry.type === 'user') {
      if (block.type === 'text' && block.text) out.push(`user: ${block.text}`)
      else if (block.type === 'tool_result') {
        const preview = flattenResult(block.content)
          .split('\n')
          .slice(0, TOOL_OUTPUT_PREVIEW_LINES)
          .join(' ')
          .slice(0, TOOL_OUTPUT_PREVIEW_CHARS)
        if (preview) out.push(`  = ${preview}`)
      }
    }
  }
  return out
}

/** A whole transcript buffer -> display lines (blank and unparseable lines contribute nothing). */
export function renderTranscriptLines(buf: string): string[] {
  return buf
    .split('\n')
    .filter((l) => l.trim())
    .flatMap(linesFromClaude)
}
