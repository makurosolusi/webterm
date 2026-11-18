import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import {
  CANVAS_IMAGE_ID_RE, CANVAS_SNIFF_BYTES, MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES,
} from '../shared/canvasBackground.schema'
import { dataDir } from './config'
import { isVideoExt, sniffMedia, type CanvasImageExt } from './canvasBackground.sniff'

export { MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES } from '../shared/canvasBackground.schema'
export { CANVAS_IMAGE_TYPES, sniffImage, sniffMedia, sniffVideo, type CanvasImageExt } from './canvasBackground.sniff'

/** In-flight upload file (`<uuid>.part`); renamed to `<uuid>.<ext>` once complete, swept at boot if a crash left it. */
export const CANVAS_PARTIAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/

/** Directory holding the wallpaper files (created on demand, owner-only like the data dir). */
export function backgroundsDir(): string {
  return join(dataDir(), 'backgrounds')
}

/** Store validated image bytes under a fresh id; returns that id. */
export async function saveCanvasImage(dir: string, bytes: Buffer, ext: CanvasImageExt): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${randomUUID()}.${ext}`
  await fs.writeFile(join(dir, id), bytes, { mode: 0o600, flag: 'wx' })
  return id
}

/** Remove a stored image; ids that do not match the id pattern are ignored (no traversal). */
export async function deleteCanvasImage(dir: string, id: string): Promise<void> {
  if (!CANVAS_IMAGE_ID_RE.test(id)) return
  await fs.rm(join(dir, id), { force: true })
}

/** Read a binary request body up to `max` bytes; drains and reports `too_large` past the cap. */
export async function readBinaryBody(req: IncomingMessage, max: number): Promise<Buffer | 'too_large'> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) { req.resume(); return 'too_large' }
  // Event-based on purpose: breaking out of `for await` destroys the socket before the 413 is sent.
  // Past the cap the rest is drained and discarded, never buffered.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buf.length
      if (total <= max) chunks.push(buf)
    })
    req.on('end', () => resolve(total > max ? 'too_large' : Buffer.concat(chunks)))
    req.on('error', (err) => reject(new Error(`read canvas image upload failed: ${err.message}`, { cause: err })))
  })
}

export type UploadResult =
  | { ok: true; id: string; ext: CanvasImageExt; animated: boolean; bytes: number }
  | { ok: false; error: 'too_large' | 'unsupported' | 'aborted' }

/**
 * Stream an upload to `<dir>/<uuid>.part` (never held in memory), sniff the first bytes, enforce the
 * per-type cap while streaming (images `MAX_CANVAS_IMAGE_BYTES`, video `MAX_CANVAS_VIDEO_BYTES`), then
 * rename atomically to `<uuid>.<ext>`. Any rejection removes the partial file; the rest of the body is
 * drained so the 413/415 reaches the client instead of a reset socket.
 */
export async function streamCanvasUpload(req: IncomingMessage, dir: string): Promise<UploadResult> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_CANVAS_VIDEO_BYTES) { req.resume(); return { ok: false, error: 'too_large' } }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const uuid = randomUUID()
  const partial = join(dir, `${uuid}.part`)
  const out = createWriteStream(partial, { mode: 0o600, flags: 'wx' })
  return new Promise<UploadResult>((resolve, reject) => {
    let total = 0
    let head = Buffer.alloc(0)
    let media: ReturnType<typeof sniffMedia> | undefined
    let rejected: 'too_large' | 'unsupported' | null = null
    let settled = false
    const fail = (err: unknown, what: string): void => {
      if (settled) return
      settled = true
      out.destroy()
      void fs.rm(partial, { force: true })
      reject(new Error(`stream canvas upload ${uuid}: ${what}: ${(err as Error).message}`, { cause: err }))
    }
    const abort = (error: 'too_large' | 'unsupported'): void => {
      rejected = error
      out.destroy() // stop writing; the body is still drained by the 'data' listener
      void fs.rm(partial, { force: true })
    }
    out.on('error', (err) => fail(err, 'write failed'))
    req.on('error', (err) => fail(err, 'read failed'))
    req.on('data', (chunk: Buffer | string) => {
      if (rejected || settled) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buf.length
      if (head.length < CANVAS_SNIFF_BYTES) {
        head = Buffer.concat([head, buf.subarray(0, CANVAS_SNIFF_BYTES - head.length)])
        if (head.length >= CANVAS_SNIFF_BYTES) {
          media = sniffMedia(head)
          if (!media) return abort('unsupported')
        }
      }
      const cap = media && !isVideoExt(media.ext) ? MAX_CANVAS_IMAGE_BYTES : MAX_CANVAS_VIDEO_BYTES
      if (total > cap) return abort('too_large')
      if (!out.write(buf)) { req.pause(); out.once('drain', () => req.resume()) }
    })
    req.on('close', () => {
      if (req.complete || settled || rejected) return
      settled = true
      out.destroy()
      void fs.rm(partial, { force: true })
      resolve({ ok: false, error: 'aborted' })
    })
    req.on('end', () => {
      if (settled) return
      if (rejected) { settled = true; resolve({ ok: false, error: rejected }); return }
      media ??= sniffMedia(head) // body shorter than the sniff window
      if (!media) { abort('unsupported'); settled = true; resolve({ ok: false, error: 'unsupported' }); return }
      const found = media
      out.end(() => {
        if (settled) return
        const id = `${uuid}.${found.ext}`
        fs.rename(partial, join(dir, id)).then(
          () => { settled = true; resolve({ ok: true, id, ext: found.ext, animated: found.animated, bytes: total }) },
          (err: unknown) => fail(err, 'rename failed'),
        )
      })
    })
  })
}
