// Magic-byte sniffing of wallpaper files. The stored extension comes from here, never from the
// client's file name or Content-Type, so a fake extension cannot smuggle another type in.
import { isAnimatedWebp } from '../shared/canvasBackground.schema'

export type CanvasImageExt = 'png' | 'jpg' | 'webp' | 'gif' | 'mp4' | 'webm'

/** Content-Type served for each stored extension. */
export const CANVAS_IMAGE_TYPES: Record<CanvasImageExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

export const isVideoExt = (ext: CanvasImageExt): boolean => ext === 'mp4' || ext === 'webm'

/** ISO base media brands accepted at offset 8 of the `ftyp` box (H.264 MP4 family). */
const MP4_BRANDS = new Set(['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'M4V '])
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FTYP_OFFSET = 4
const BRAND_OFFSET = 8

const ascii = (buf: Buffer, start: number, text: string): boolean => buf.subarray(start, start + text.length).toString('latin1') === text

/** Image format from magic bytes, or null when the bytes are not png/jpeg/webp/gif. */
export function sniffImage(buf: Buffer): CanvasImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 6 && (ascii(buf, 0, 'GIF87a') || ascii(buf, 0, 'GIF89a'))) return 'gif'
  if (buf.length >= 12 && ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'webp'
  return null
}

/** MP4 (known brand) or WebM (EBML header whose DocType is `webm`), else null. */
export function sniffVideo(buf: Buffer): 'mp4' | 'webm' | null {
  if (buf.length >= BRAND_OFFSET + 4 && ascii(buf, FTYP_OFFSET, 'ftyp') && MP4_BRANDS.has(buf.subarray(BRAND_OFFSET, BRAND_OFFSET + 4).toString('latin1'))) return 'mp4'
  // DocType sits right after the EBML header, well inside the first 64 bytes; Matroska says `matroska`.
  if (buf.length >= EBML_MAGIC.length && buf.subarray(0, EBML_MAGIC.length).equals(EBML_MAGIC) && buf.includes('webm', 0, 'latin1')) return 'webm'
  return null
}

/** Format of the first bytes of an upload, plus whether the file moves (video, animated WebP, GIF). */
export function sniffMedia(head: Buffer): { ext: CanvasImageExt; animated: boolean } | null {
  const ext = sniffImage(head) ?? sniffVideo(head)
  if (!ext) return null
  return { ext, animated: isVideoExt(ext) || ext === 'gif' || (ext === 'webp' && isAnimatedWebp(head)) }
}
