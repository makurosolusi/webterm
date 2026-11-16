// Files a chat composer receives by paste, drop or picker: the clipboard / drop readers copied from
// the terminal file-drop helpers (`pastedFiles`, `pasteHasText`, `clipboardImages`, `uploadNameFor`),
// plus `prepareImage`, which turns an image into base64 Claude accepts (downscaled on a canvas when it
// is over the edge or byte limit, as Claude Code does for a pasted image, instead of refusing it).
import { AGENT_CHAT_IMAGE_MAX_B64, AGENT_CHAT_IMAGE_MAX_EDGE, AGENT_CHAT_IMAGE_TYPES } from '../../shared/agentChat.wire'

/** One pending attachment of the composer: base64 without the data: prefix. A host may queue non-image
 * files here too (Central's text files, `text/plain`); the tray shows those as a file chip. */
export interface ComposerImage { name: string; mediaType: string; data: string }

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'application/pdf': 'pdf', 'text/plain': 'txt',
}
/** JPEG quality of the last-resort re-encode of an image still over the byte limit. */
const JPEG_QUALITY = 0.85
const MB = 1024 * 1024

/** A file name for clipboard bytes that have none: `pasted-<stamp>.<ext>` from the MIME type. */
export function uploadNameFor(file: { name: string; type: string }): string {
  if (file.name) return file.name
  const ext = EXT_BY_TYPE[file.type] ?? (file.type.split('/')[1] || 'bin')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `pasted-${stamp}.${ext}`
}

/** Files of a paste: a file-manager copy on `files`, raw clipboard bytes (a screenshot) as file items. */
export function pastedFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const files = Array.from(dt.files ?? [])
  if (files.length) return files
  return Array.from(dt.items ?? []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f)
}

/** True when the paste carried text: that text is the textarea's to handle. */
export function pasteHasText(dt: DataTransfer | null): boolean {
  return !!dt && !!dt.getData('text/plain')
}

/**
 * Images on the clipboard that the paste event did not hand over (Chromium filters `clipboardData` to
 * what a text target can hold). Asks the async Clipboard API; no API, no permission or no image = [].
 */
export async function clipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read) return []
  let items: ClipboardItems
  try {
    items = await navigator.clipboard.read()
  } catch (err) {
    // Declined permission / insecure context: the paste stays the no-op it was.
    if (err instanceof DOMException) return []
    throw err
  }
  const out: File[] = []
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    out.push(new File([await item.getType(type)], uploadNameFor({ name: '', type }), { type }))
  }
  return out
}

/** Base64 of a blob (no data: prefix). */
export function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`could not read ${blob instanceof File ? blob.name : 'the file'}: ${reader.error?.message ?? 'read failed'}`))
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : ''
      resolve(res.slice(res.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/** An image type Claude takes as an image block (anything else is attached as a file path). */
export const isClaudeImage = (file: File): boolean => AGENT_CHAT_IMAGE_TYPES.includes(file.type)

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))

/** `file` as base64 within AGENT_CHAT_IMAGE_MAX_EDGE / AGENT_CHAT_IMAGE_MAX_B64; throws a user-facing reason. */
export async function prepareImage(file: File): Promise<ComposerImage> {
  const name = uploadNameFor(file)
  // No createImageBitmap (old browser, test DOM): the bytes go as they are, the server checks the cap.
  const bitmap = typeof createImageBitmap === 'function'
    ? await createImageBitmap(file).catch((err: unknown) => { throw new Error(`${name} could not be read as an image (${err instanceof Error ? err.message : 'decode failed'}).`) })
    : null
  try {
    const edge = bitmap ? Math.max(bitmap.width, bitmap.height) : 0
    const data = await readAsBase64(file)
    if (edge <= AGENT_CHAT_IMAGE_MAX_EDGE && data.length <= AGENT_CHAT_IMAGE_MAX_B64) return { name, mediaType: file.type, data }
    if (!bitmap) throw new Error(`${name} is over ${AGENT_CHAT_IMAGE_MAX_B64 / MB} MB.`)
    const scale = Math.min(1, AGENT_CHAT_IMAGE_MAX_EDGE / edge)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const keep = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    for (const [type, quality] of [[keep, undefined], ['image/jpeg', JPEG_QUALITY]] as const) {
      const blob = await encode(canvas, type, quality)
      if (!blob) continue
      const b64 = await readAsBase64(blob)
      if (b64.length <= AGENT_CHAT_IMAGE_MAX_B64) return { name, mediaType: blob.type || type, data: b64 }
    }
    throw new Error(`${name} is still over ${AGENT_CHAT_IMAGE_MAX_B64 / MB} MB after downscaling.`)
  } finally {
    bitmap?.close()
  }
}
