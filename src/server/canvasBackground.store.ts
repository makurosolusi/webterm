// Canvas wallpaper image files: `<dataDir>/backgrounds/<uuid>.<ext>`. The file name is always
// server-generated (uuid + extension from the sniffed format); the client's file name is never
// used, so no path a client sends can reach the filesystem except through `CANVAS_IMAGE_ID_RE`.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { CANVAS_IMAGE_ID_RE } from '../shared/canvasBackground.schema'
export { MAX_CANVAS_IMAGE_BYTES } from '../shared/canvasBackground.schema'
import { dataDir } from './config'

export type CanvasImageExt = 'png' | 'jpg' | 'webp' | 'gif'

/** Content-Type served for each stored extension. */
export const CANVAS_IMAGE_TYPES: Record<CanvasImageExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const ascii = (buf: Buffer, start: number, text: string): boolean => buf.subarray(start, start + text.length).toString('latin1') === text

/** Image format from magic bytes, or null when the bytes are not png/jpeg/webp/gif. */
export function sniffImage(buf: Buffer): CanvasImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 6 && (ascii(buf, 0, 'GIF87a') || ascii(buf, 0, 'GIF89a'))) return 'gif'
  if (buf.length >= 12 && ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'webp'
  return null
}

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

/** Bytes + content type for a stored id, or null when the id is invalid or the file is gone. */
export async function readCanvasImage(dir: string, id: string): Promise<{ bytes: Buffer; type: string } | null> {
  if (!CANVAS_IMAGE_ID_RE.test(id)) return null
  const ext = id.slice(id.lastIndexOf('.') + 1) as CanvasImageExt
  try {
    return { bytes: await fs.readFile(join(dir, id)), type: CANVAS_IMAGE_TYPES[ext] }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`read canvas image ${id} failed: ${(err as Error).message}`, { cause: err })
  }
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
