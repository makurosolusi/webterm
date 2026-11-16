// Attachments of an agent chat user turn: images sent to Claude as base64 image blocks (the shape of
// `Base64ImageSource` in @anthropic-ai/sdk, carried by `SDKUserMessage.message: MessageParam`), and
// other files staged under the webterm data dir so their path can go into the prompt. Validation lives here so the route stays a thin boundary.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import npath from 'node:path'
import type { Readable } from 'node:stream'
import {
  AGENT_CHAT_IMAGE_MAX_B64, AGENT_CHAT_IMAGE_TYPES, AGENT_CHAT_IMAGES_MAX, AGENT_CHAT_IMAGES_TOTAL_B64,
  type AgentChatEvent, type AgentChatImage, type AgentChatPart,
} from '../../shared/agentChat.wire'
import { FS_ERR_STATUS } from '../../shared/fsContract'
import { dataDir } from '../config'
import { errnoOf } from '../fsAtomic'
import { uploadFile } from '../fsUpload'
import { createLogger } from '../logs'

const log = createLogger('agent-chat')

/** Base64 chars of image data the replay log keeps; older images replay as placeholders. */
export const AGENT_CHAT_LOG_IMAGE_B64_MAX = 32 * 1024 * 1024
/** Subfolder of the data dir holding staged files, one folder per node. */
export const AGENT_CHAT_UPLOADS_SUBDIR = 'agent-chat-uploads'
/** Staged files older than this are removed on the node's next upload. */
export const AGENT_CHAT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60_000
const UPLOAD_NAME_MAX = 100

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Media type from the first bytes; the API refuses an image whose bytes do not match its declared type. */
export function sniffImage(b64: string): MediaType | undefined {
  const head = Buffer.from(b64.slice(0, 16), 'base64')
  const at = (i: number, s: string): boolean => head.subarray(i, i + s.length).toString('latin1') === s
  if (at(0, '\x89PNG')) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (at(0, 'GIF8')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** `images` of a send body: valid list (media type corrected to the sniffed one) or the reason it is refused. */
export function parseImages(raw: unknown): { images: AgentChatImage[] } | { reason: string } {
  if (raw === undefined) return { images: [] }
  if (!Array.isArray(raw)) return { reason: 'images must be an array.' }
  if (raw.length > AGENT_CHAT_IMAGES_MAX) return { reason: `At most ${AGENT_CHAT_IMAGES_MAX} images per message.` }
  const images: AgentChatImage[] = []
  let total = 0
  for (const [i, img] of raw.entries()) {
    const { mediaType, data } = (img ?? {}) as { mediaType?: unknown; data?: unknown }
    if (typeof mediaType !== 'string' || !AGENT_CHAT_IMAGE_TYPES.includes(mediaType)) return { reason: `Image ${i + 1}: type must be PNG, JPEG, GIF or WebP.` }
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data)) return { reason: `Image ${i + 1}: data must be base64.` }
    if (data.length > AGENT_CHAT_IMAGE_MAX_B64) return { reason: `Image ${i + 1} is over ${AGENT_CHAT_IMAGE_MAX_B64} bytes (base64).` }
    const sniffed = sniffImage(data)
    if (!sniffed) return { reason: `Image ${i + 1} is not a PNG, JPEG, GIF or WebP image.` }
    total += data.length
    images.push({ mediaType: sniffed, data })
  }
  if (total > AGENT_CHAT_IMAGES_TOTAL_B64) return { reason: `Images are over ${AGENT_CHAT_IMAGES_TOTAL_B64} bytes (base64) in total.` }
  return { images }
}

/** Folder of one node's staged files; also an `additionalDirectories` entry of its session, so Claude reads them without a prompt. */
export function agentChatUploadsDir(nodeId: string, root = npath.join(dataDir(), AGENT_CHAT_UPLOADS_SUBDIR)): string {
  return npath.join(root, nodeId)
}

/** SDK user content: the plain string without images, else image blocks then the text block (as the CLI sends a paste). */
export function userContent(text: string, images: readonly AgentChatImage[]): SDKUserMessage['message']['content'] {
  if (images.length === 0) return text
  return [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as MediaType, data: i.data } })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ]
}

/**
 * One user turn: the SDK message and the parts of its `message` event, sharing one id. The SDK keeps a
 * streamed `uuid` as the transcript entry's uuid (sdk.d.ts ForkSessionOptions.upToMessageId), so the
 * history copy of this turn carries the live event's messageId and the client dedupes by id.
 */
export function userTurn(text: string, images: readonly AgentChatImage[], priority?: 'now' | 'next'): { id: string; message: SDKUserMessage; parts: AgentChatPart[] } {
  const id = randomUUID()
  return {
    id,
    message: { type: 'user', uuid: id, message: { role: 'user', content: userContent(text, images) }, parent_tool_use_id: null, ...(priority ? { priority } : {}) },
    parts: userParts(text, images),
  }
}

/** Parts of the user `message` event: images first, as in the content sent to Claude. */
export function userParts(text: string, images: readonly AgentChatImage[]): AgentChatPart[] {
  return [...images.map((i): AgentChatPart => ({ k: 'image', mediaType: i.mediaType, data: i.data })), ...(text ? [{ k: 'text' as const, text }] : [])]
}

const imageB64 = (e: AgentChatEvent): number =>
  e.t === 'message' ? e.parts.reduce((n, p) => n + (p.k === 'image' ? p.data?.length ?? 0 : 0), 0) : 0

/** Keeps the newest `max` base64 chars of image data in `log`; older image parts lose `data` (copied, never mutated). */
export function capLogImages(log: AgentChatEvent[], max = AGENT_CHAT_LOG_IMAGE_B64_MAX): void {
  let kept = 0
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] as AgentChatEvent
    const n = imageB64(e)
    if (n === 0) continue
    if (kept + n <= max) { kept += n; continue }
    if (e.t === 'message') log[i] = { ...e, parts: e.parts.map((p) => (p.k === 'image' ? { k: 'image', mediaType: p.mediaType } : p)) }
  }
}

/** Safe single-segment name: anything outside [A-Za-z0-9._-] becomes `_`, no leading dot, unique prefix. */
export function stagedName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(-UPLOAD_NAME_MAX) || 'file'
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}-${clean}`
}

/** Remove staged files in `dir` older than the TTL; a file gone meanwhile is skipped. */
async function sweepStaged(dir: string, now: number): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const p = npath.join(dir, name)
    const st = await fs.stat(p).catch((err: unknown) => { if (errnoOf(err) === 'ENOENT') return null; throw err })
    if (st?.isFile() && now - st.mtimeMs > AGENT_CHAT_UPLOAD_TTL_MS) await fs.rm(p, { force: true })
  }
}

/** Stage `stream` as a new file in `dir` (created 0700); resolves to its absolute path or an error message. */
export async function stageUpload(dir: string, name: string, stream: Readable, maxBytes: number): Promise<{ path: string } | { status: number; reason: string }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const staged = stagedName(name)
  const r = await uploadFile(dir, staged, stream, maxBytes)
  if (!r.ok) return { status: FS_ERR_STATUS[r.code], reason: `Could not stage ${name}: ${r.error}` }
  // The file is staged either way: a failed sweep is logged, never the upload's failure.
  await sweepStaged(dir, Date.now()).catch((err: unknown) =>
    log.warn('agent_chat.sweep_failed', 'agent chat upload sweep failed', { operation: 'sweep', error: err instanceof Error ? err.name : typeof err }))
  return { path: npath.join(dir, staged) }
}
