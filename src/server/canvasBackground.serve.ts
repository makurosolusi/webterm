// Serving a stored wallpaper file with HTTP Range. Video needs it: WebKit (the native macOS app)
// refuses to play a `<video>` whose server ignores Range, and seeking/looping depends on it too.
// Files are streamed from disk, never read whole.
import { createReadStream, promises as fs } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CANVAS_IMAGE_ID_RE } from '../shared/canvasBackground.schema'
import { CANVAS_IMAGE_TYPES, type CanvasImageExt } from './canvasBackground.sniff'
import { createLogger } from './logs'

const log = createLogger('canvas-background')

/** Inclusive byte window. */
export type ByteRange = { start: number; end: number }

export interface CanvasFile { path: string; size: number; type: string }

const RANGE_RE = /^bytes=(\d*)-(\d*)$/

/** Parse a single-range `Range` header against `size`: window, `'invalid'` (416), or null (serve all). Multi-range and other units are ignored. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  const m = header ? RANGE_RE.exec(header.trim()) : null
  if (!m) return null
  const [, from, to] = m
  if (from === '' && to === '') return 'invalid'
  if (from === '') { // suffix: the last N bytes
    const n = Number(to)
    return n === 0 || size === 0 ? 'invalid' : { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  return start >= size || end < start ? 'invalid' : { start, end }
}

/** Stored file for `id` (path, size, content type), or null for a bad id or a missing file. */
export async function statCanvasFile(dir: string, id: string): Promise<CanvasFile | null> {
  if (!CANVAS_IMAGE_ID_RE.test(id)) return null
  const path = join(dir, id)
  const ext = id.slice(id.lastIndexOf('.') + 1) as CanvasImageExt
  try {
    return { path, size: (await fs.stat(path)).size, type: CANVAS_IMAGE_TYPES[ext] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`stat canvas file ${id} failed: ${(err as Error).message}`, { cause: err })
  }
}

/** Answer GET/HEAD for a stored file: 200, 206 for a valid Range, 416 for an unsatisfiable one. */
export function serveCanvasFile(res: ServerResponse, file: CanvasFile, range: string | undefined, head: boolean): void {
  const r = parseByteRange(range, file.size)
  res.setHeader('Content-Type', file.type)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Ids are immutable (a replacement gets a new id), so the browser may cache; `private`: behind auth.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  if (r === 'invalid') {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${file.size}`)
    res.end()
    return
  }
  const win = r ?? { start: 0, end: file.size - 1 }
  res.statusCode = r ? 206 : 200
  if (r) res.setHeader('Content-Range', `bytes ${win.start}-${win.end}/${file.size}`)
  res.setHeader('Content-Length', String(file.size === 0 ? 0 : win.end - win.start + 1))
  if (head || file.size === 0) { res.end(); return }
  const stream = createReadStream(file.path, win)
  stream.on('error', (err) => {
    // Headers are already sent: a mid-stream failure can only cut the connection (the client re-requests).
    log.warn('canvas-background.serve_failed', 'Cannot stream canvas background file', { cause: err.message })
    res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
