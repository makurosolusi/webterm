// Transcript reading + claude JSONL parsing for the read-only context-link backend.
// Split out of `contextLink.ts` to keep each module under the file-health budget.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { transcriptPathAllowed } from './transcriptPath'

const TOOL_ARG_MAX = 200
const TOOL_RESULT_MAX = 500
/** Transcript bisa tumbuh tanpa batas; context-link hanya perlu ekor percakapan terbaru. */
const TRANSCRIPT_READ_MAX = 4 * 1024 * 1024

/**
 * Baca transcript dengan pertahanan terhadap swap symlink: path divalidasi saat hook menulis,
 * tapi file itu dimiliki agent yang sama dan bisa diganti sebelum kita membacanya. Karena itu
 * `lstat` menolak symlink/FIFO/device, `realpath` memastikan target masih di dalam root yang
 * diizinkan, dan `O_NOFOLLOW` menutup celah antara dua syscall itu. Ukuran dibatasi supaya
 * `/dev/zero` atau file raksasa tidak memblokir event loop.
 */
export function readTranscriptFile(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null
    const real = realpathSync(path)
    if (!transcriptPathAllowed(real)) return null
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return null
      const start = Math.max(0, stat.size - TRANSCRIPT_READ_MAX)
      const length = stat.size - start
      if (length <= 0) return ''
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// --- claude transcript parser (ported verbatim from nodeterm-web) ---

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Claude tool_result content: a string, or content parts carrying `.text`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const part = c as { type?: string; text?: string }
        return part && part.type === 'text' ? part.text ?? '' : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function toolArg(input: unknown): string {
  const i = input as Record<string, unknown> | undefined
  if (!i) return ''
  const a = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt
  return typeof a === 'string' ? ` ${a.slice(0, TOOL_ARG_MAX)}` : ''
}

/** One claude transcript JSONL line -> 0..n display strings. */
export function linesFromClaude(raw: string): string[] {
  const o = parseJson(raw) as { type?: string; message?: { content?: unknown } } | undefined
  if (!o) return []
  const content = o.message?.content
  const res: string[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`assistant: ${c.text}`)
      else if (c.type === 'tool_use') res.push(`  $ ${c.name || 'tool'}${toolArg(c.input)}`)
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; content?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`user: ${c.text}`)
      else if (c.type === 'tool_result') {
        const s = textOf(c.content).split('\n').slice(0, 3).join(' ').slice(0, TOOL_RESULT_MAX)
        if (s) res.push(`  = ${s}`)
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    res.push(`user: ${content}`)
  }
  return res
}

// webterm transcripts are claude jsonl only — no per-agent dispatch needed.
export function renderTranscriptLines(buf: string): string[] {
  const lines: string[] = []
  for (const raw of buf.split('\n')) if (raw.trim()) lines.push(...linesFromClaude(raw))
  return lines
}
