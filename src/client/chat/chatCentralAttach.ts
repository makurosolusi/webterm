// How the Central chat resolves attached files. Its Claude runs without built-in tools and cannot open
// a path, so nothing is uploaded: images become pending images (sent as image blocks), UTF-8 text
// files are queued as `text/plain` items whose content the server inlines into the prompt, anything
// else is refused. One failure never drops the other files.
import {
  CENTRAL_ATTACH_KINDS_MESSAGE, CENTRAL_FILE_MAX_BYTES, CENTRAL_IMAGES_TOTAL_B64, centralImagesTooLarge, isUtf8Text,
} from '../../shared/centralAttach'
import type { ChatPart, SendMessageInput } from './chatTypes'
import { isClaudeImage, prepareImage, readAsBase64, uploadNameFor, type ComposerImage } from './chatAttach'
import type { AttachFiles } from './chatComposerAttach'

/** Media type marking a queued text file (as opposed to an image) among the composer's items. */
export const CENTRAL_TEXT_FILE_TYPE = 'text/plain'

async function textFile(file: File, name: string): Promise<ComposerImage> {
  if (file.size > CENTRAL_FILE_MAX_BYTES) throw new Error(`over ${CENTRAL_FILE_MAX_BYTES / 1024} KB.`)
  if (!isUtf8Text(new Uint8Array(await file.arrayBuffer()))) throw new Error(CENTRAL_ATTACH_KINDS_MESSAGE)
  return { name, mediaType: CENTRAL_TEXT_FILE_TYPE, data: await readAsBase64(file) }
}

export const centralChatAttach: AttachFiles = async (files) => {
  const done = await Promise.all(files.map(async (file): Promise<{ item?: ComposerImage; failed?: string }> => {
    const name = uploadNameFor(file)
    try {
      return { item: isClaudeImage(file) ? await prepareImage(file) : await textFile(file, name) }
    } catch (err) {
      return { failed: `${name}: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
  }))
  return {
    images: done.flatMap((d) => (d.item ? [d.item] : [])),
    text: '',
    failed: done.flatMap((d) => (d.failed ? [d.failed] : [])),
  }
}

/** Composer items as message parts (the optimistic echo keeps the bytes, so a failed send can be retried). */
export function centralParts(items: readonly ComposerImage[]): ChatPart[] {
  return [
    ...items.filter((i) => i.mediaType !== CENTRAL_TEXT_FILE_TYPE).map((i): ChatPart => ({ type: 'image', mediaType: i.mediaType, data: i.data })),
    // Bytes of base64: 3 per 4 chars, minus the padding.
    ...items.filter((i) => i.mediaType === CENTRAL_TEXT_FILE_TYPE).map((i): ChatPart => ({
      type: 'file', name: i.name, data: i.data, size: (i.data.length * 3) / 4 - (i.data.match(/=*$/)?.[0].length ?? 0),
    })),
  ]
}

/** The send body's `images`/`files` for these parts: bytes when held, else the stored ref; or why not to send. */
export function centralWire(parts: readonly ChatPart[]): Pick<SendMessageInput, 'images' | 'files'> | { reason: string } {
  const images: NonNullable<SendMessageInput['images']> = []
  const files: NonNullable<SendMessageInput['files']> = []
  let b64 = 0
  for (const p of parts) {
    if (p.type === 'image' && p.data) { images.push({ mediaType: p.mediaType, data: p.data }); b64 += p.data.length }
    else if (p.type === 'image' && p.ref) images.push({ ref: p.ref })
    else if (p.type === 'file' && p.data) files.push({ name: p.name, data: p.data })
    else if (p.type === 'file' && p.ref) files.push({ name: p.name, ref: p.ref })
  }
  if (b64 > CENTRAL_IMAGES_TOTAL_B64) return { reason: centralImagesTooLarge() }
  return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }
}
