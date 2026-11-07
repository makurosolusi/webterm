// Attachments of a Central chat message (send route boundary). Images: validated with Agent Chat's
// parser (type, size, count, magic bytes), stored once on disk per conversation and referenced from
// the message part by their SHA-256, so neither the message row nor the event log holds image bytes.
// Text files: strict UTF-8, capped, inlined into the model prompt as fenced blocks; only name + size
// are kept in history. Never logs file contents or image data.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentChatImage } from '../../../shared/agentChat.wire'
import {
  CENTRAL_ATTACH_KINDS_MESSAGE, CENTRAL_FILE_MAX_BYTES, CENTRAL_FILES_MAX, CENTRAL_FILES_TOTAL_BYTES, isUtf8Text,
} from '../../../shared/centralAttach'
import { parseImages, sniffImage } from '../../agentChat/agentChat.attach'
import { dataDir } from '../../config'
import { errnoOf } from '../../fsAtomic'
import type { MessagePart } from '../conversationModel'

export interface CentralFile { name: string; text: string; size: number }
export interface CentralAttachments { images: AgentChatImage[]; files: CentralFile[] }

const NAME_MAX = 200
const CONTROL = /[\u0000-\u001f\u007f]/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const REF = /^[0-9a-f]{64}$/
const KB = 1024

/** `images` and `files` of a send body, or the reason they are refused. */
export function parseAttachments(body: Record<string, unknown>): CentralAttachments | { reason: string } {
  const images = parseImages(body['images'])
  if ('reason' in images) return images
  const raw = body['files']
  if (raw === undefined) return { images: images.images, files: [] }
  if (!Array.isArray(raw)) return { reason: 'files must be an array.' }
  if (raw.length > CENTRAL_FILES_MAX) return { reason: `At most ${CENTRAL_FILES_MAX} files per message.` }
  const files: CentralFile[] = []
  let total = 0
  for (const [i, entry] of raw.entries()) {
    const { name, data } = (entry ?? {}) as { name?: unknown; data?: unknown }
    if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX || CONTROL.test(name)) return { reason: `File ${i + 1}: name must be 1-${NAME_MAX} characters.` }
    // Base64 is 4/3 of the bytes: refuse an oversized string before decoding it.
    if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data) || data.length > Math.ceil(CENTRAL_FILE_MAX_BYTES / 3) * 4) {
      return { reason: `${name} must be base64 of at most ${CENTRAL_FILE_MAX_BYTES / KB} KB.` }
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > CENTRAL_FILE_MAX_BYTES) return { reason: `${name} is over ${CENTRAL_FILE_MAX_BYTES / KB} KB.` }
    if (!isUtf8Text(bytes)) return { reason: `${name} is not a UTF-8 text file. ${CENTRAL_ATTACH_KINDS_MESSAGE}` }
    total += bytes.length
    if (total > CENTRAL_FILES_TOTAL_BYTES) return { reason: `Files are over ${CENTRAL_FILES_TOTAL_BYTES / KB} KB in total.` }
    files.push({ name: name.trim(), text: bytes.toString('utf8'), size: bytes.length })
  }
  return { images: images.images, files }
}

/** One folder per conversation, named by a hash (conversation ids hold `:`). */
function imageDir(conversationId: string): string {
  return join(dataDir(), 'central', 'images', createHash('sha256').update(conversationId).digest('hex').slice(0, 32))
}

/** Writes each image once (content-addressed) and answers its `image` part. */
export function storeImages(conversationId: string, images: readonly AgentChatImage[]): MessagePart[] {
  if (images.length === 0) return []
  const dir = imageDir(conversationId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return images.map((img) => {
    const bytes = Buffer.from(img.data, 'base64')
    const ref = createHash('sha256').update(bytes).digest('hex')
    try {
      writeFileSync(join(dir, ref), bytes, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      // Same bytes already stored under the same name: nothing to write.
      if (errnoOf(err) !== 'EEXIST') throw new Error(`central: could not store image ${ref.slice(0, 8)} for ${conversationId}: ${errnoOf(err) || 'unknown'}`, { cause: err })
    }
    return { type: 'image', mediaType: img.mediaType, ref }
  })
}

/** Bytes and sniffed type of a stored image of this conversation; undefined = no such image. */
export function readImage(conversationId: string, ref: string): { mediaType: string; bytes: Buffer } | undefined {
  if (!REF.test(ref)) return undefined
  let bytes: Buffer
  try {
    bytes = readFileSync(join(imageDir(conversationId), ref))
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return undefined
    throw new Error(`central: could not read image ${ref.slice(0, 8)} of ${conversationId}: ${errnoOf(err) || 'unknown'}`, { cause: err })
  }
  const mediaType = sniffImage(bytes.subarray(0, 12).toString('base64'))
  return mediaType ? { mediaType, bytes } : undefined
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
