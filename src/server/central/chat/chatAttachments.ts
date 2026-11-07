// Attachments of a Central chat message (send route boundary). Images: validated with Agent Chat's
// parser (type, size, count, magic bytes) plus Central's own total cap (stdin), stored on disk
// (chatAttachStore) and referenced from the message part, so neither the message row nor the event log
// holds image bytes. Text files: strict UTF-8, capped, stored the same way and inlined into the model
// prompt as fenced blocks; history keeps name, size and the reference. An entry may name a stored blob
// by `ref` instead of `data` (Retry resends that way, no re-upload). Never logs contents or image data.
import type { AgentChatImage } from '../../../shared/agentChat.wire'
import { AGENT_CHAT_IMAGES_MAX } from '../../../shared/agentChat.wire'
import {
  CENTRAL_ATTACH_KINDS_MESSAGE, CENTRAL_FILE_MAX_BYTES, CENTRAL_FILES_MAX, CENTRAL_FILES_TOTAL_BYTES,
  CENTRAL_IMAGES_TOTAL_B64, centralImagesTooLarge, isUtf8Text,
} from '../../../shared/centralAttach'
import { parseImages, sniffImage } from '../../agentChat/agentChat.attach'
import type { MessagePart } from '../conversationModel'
import { readBlob, storeBlob } from './chatAttachStore'

export interface CentralFile { name: string; text: string; size: number }
export interface CentralAttachments { images: AgentChatImage[]; files: CentralFile[] }

const NAME_MAX = 200
const CONTROL = /[\u0000-\u001f\u007f]/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const KB = 1024
const GONE = 'is no longer stored (attachments are kept 30 days after their last send); attach it again.'

type Entry = Record<string, unknown>
const entries = (raw: unknown): Entry[] | undefined => (Array.isArray(raw) ? raw.map((e) => (e ?? {}) as Entry) : undefined)

/** `images` and `files` of a send body for this conversation, or the reason they are refused. */
export function parseAttachments(body: Record<string, unknown>, conversationId: string): CentralAttachments | { reason: string } {
  // Counts first: a `ref` costs a disk read, so a long list is refused before any is resolved.
  const rawImages = entries(body['images'])
  if (rawImages && rawImages.length > AGENT_CHAT_IMAGES_MAX) return { reason: `At most ${AGENT_CHAT_IMAGES_MAX} images per message.` }
  const resolved: Entry[] = []
  for (const [i, e] of (rawImages ?? []).entries()) {
    if (e['data'] !== undefined || typeof e['ref'] !== 'string') { resolved.push(e); continue }
    const bytes = readBlob(conversationId, e['ref'])
    const mediaType = bytes && sniffImage(bytes.subarray(0, 12).toString('base64'))
    if (!bytes || !mediaType) return { reason: `Image ${i + 1} ${GONE}` }
    resolved.push({ mediaType, data: bytes.toString('base64') })
  }
  const images = parseImages(rawImages ? resolved : body['images'])
  if ('reason' in images) return images
  if (images.images.reduce((n, img) => n + img.data.length, 0) > CENTRAL_IMAGES_TOTAL_B64) return { reason: centralImagesTooLarge() }
  const raw = body['files']
  if (raw === undefined) return { images: images.images, files: [] }
  const list = entries(raw)
  if (!list) return { reason: 'files must be an array.' }
  if (list.length > CENTRAL_FILES_MAX) return { reason: `At most ${CENTRAL_FILES_MAX} files per message.` }
  const files: CentralFile[] = []
  let total = 0
  for (const [i, { name, data, ref }] of list.entries()) {
    if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX || CONTROL.test(name)) return { reason: `File ${i + 1}: name must be 1-${NAME_MAX} characters.` }
    let bytes: Buffer | undefined
    if (data === undefined && typeof ref === 'string') {
      bytes = readBlob(conversationId, ref)
      if (!bytes) return { reason: `${name} ${GONE}` }
    } else {
      // Base64 is 4/3 of the bytes: refuse an oversized string before decoding it.
      if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data) || data.length > Math.ceil(CENTRAL_FILE_MAX_BYTES / 3) * 4) {
        return { reason: `${name} must be base64 of at most ${CENTRAL_FILE_MAX_BYTES / KB} KB.` }
      }
      bytes = Buffer.from(data, 'base64')
    }
    if (bytes.length > CENTRAL_FILE_MAX_BYTES) return { reason: `${name} is over ${CENTRAL_FILE_MAX_BYTES / KB} KB.` }
    if (!isUtf8Text(bytes)) return { reason: `${name} is not a UTF-8 text file. ${CENTRAL_ATTACH_KINDS_MESSAGE}` }
    total += bytes.length
    if (total > CENTRAL_FILES_TOTAL_BYTES) return { reason: `Files are over ${CENTRAL_FILES_TOTAL_BYTES / KB} KB in total.` }
    files.push({ name: name.trim(), text: bytes.toString('utf8'), size: bytes.length })
  }
  return { images: images.images, files }
}

/** Stores the attachments and answers their parts, images first (as sent to Claude). */
export function storeAttachments(conversationId: string, a: CentralAttachments): MessagePart[] {
  return [
    ...a.images.map((img): MessagePart => ({ type: 'image', mediaType: img.mediaType, ref: storeBlob(conversationId, Buffer.from(img.data, 'base64')) })),
    ...a.files.map((f): MessagePart => ({ type: 'file', name: f.name, size: f.size, ref: storeBlob(conversationId, Buffer.from(f.text, 'utf8')) })),
  ]
}

/** Bytes and sniffed type of a stored image of this conversation; undefined = no such image. */
export function readImage(conversationId: string, ref: string): { mediaType: string; bytes: Buffer } | undefined {
  const bytes = readBlob(conversationId, ref)
  const mediaType = bytes && sniffImage(bytes.subarray(0, 12).toString('base64'))
  return bytes && mediaType ? { mediaType, bytes } : undefined
}

/** The prompt with each text file appended as a fenced block (fence longer than any backtick run inside). */
export function withFiles(prompt: string, files: readonly CentralFile[]): string {
  if (files.length === 0) return prompt
  const blocks = files.map((f) => {
    const longest = Math.max(0, ...(f.text.match(/`+/g) ?? []).map((run) => run.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `Attached file ${JSON.stringify(f.name)}:\n${fence}\n${f.text}\n${fence}`
  })
  return [prompt, ...blocks].filter(Boolean).join('\n\n')
}
