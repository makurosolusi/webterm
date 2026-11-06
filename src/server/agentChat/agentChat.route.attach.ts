// Attachment verbs of the agent chat route: the `send` body (text and/or images), `upload` (stage a
// non-image file, answer its path) and `history?image=` (one transcript image as bytes). Split from
// agentChat.route.ts so that file stays a dispatcher.
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_TEXT_MAX, type AgentChatImage } from '../../shared/agentChat.wire'
import { filesUploadMaxBytes } from '../envRegistry.files'
import { json, type RouteCtx } from '../routes/route.core'
import { agentChatUploadsDir, parseImages, stageUpload } from './agentChat.attach'
import { transcriptImage } from './agentChat.history'

/** Bytes of a `send` body: every image at its base64 cap plus the text, JSON-escaped. */
export const AGENT_CHAT_SEND_BODY_MAX_BYTES = 21 * 1024 * 1024
/** Chars of an upload's original file name. */
const UPLOAD_NAME_MAX = 255
/** Browser cache of a transcript image: it never changes under its reference. */
const IMAGE_CACHE = 'private, max-age=86400'
const PRIORITIES = new Set(['now', 'next'])

type Ctx = Pick<RouteCtx, 'req' | 'res' | 'url'>
export interface SendRequest { text: string; priority?: 'now' | 'next'; images: AgentChatImage[] }

/** A send body, or the 400 reason. Text may be empty when images carry the message. */
export function parseSend(b: Record<string, unknown>): SendRequest | { reason: string } {
  if (typeof b.text !== 'string') return { reason: 'text must be a string.' }
  if (b.text.length > AGENT_CHAT_TEXT_MAX) return { reason: `text is over ${AGENT_CHAT_TEXT_MAX} characters.` }
  if (b.priority !== undefined && !PRIORITIES.has(b.priority as string)) return { reason: 'priority must be "now" or "next".' }
  const parsed = parseImages(b.images)
  if ('reason' in parsed) return parsed
  const text = b.text.trim() ? b.text : ''
  if (!text && parsed.images.length === 0) return { reason: 'A message needs text or at least one image.' }
  return { text, images: parsed.images, ...(b.priority ? { priority: b.priority as 'now' | 'next' } : {}) }
}

/** `POST upload?name=` with the raw file as body: staged under `<root>/<nodeId>/`, answers `{ path }`. */
export async function uploadVerb(c: Ctx, nodeId: string, root?: string): Promise<true> {
  const name = c.url.searchParams.get('name') ?? ''
  if (!name || name.length > UPLOAD_NAME_MAX) {
    json(c.res, 400, { error: 'bad_request', reason: `name must be 1-${UPLOAD_NAME_MAX} characters.` })
    return true
  }
  const r = await stageUpload(agentChatUploadsDir(nodeId, root), name, c.req, filesUploadMaxBytes())
  if ('path' in r) json(c.res, 200, { path: r.path })
  else json(c.res, r.status, { error: r.status === 413 ? 'too_large' : 'upload_failed', reason: r.reason })
  return true
}

/** Answer one transcript image (`ref` from a history `image` part) as its bytes. */
export function imageVerb(c: Ctx, msgs: SessionMessage[], ref: string): true {
  const img = transcriptImage(msgs, ref)
  if (!img) {
    json(c.res, 404, { error: 'not_found', reason: `No image ${ref} in this transcript.` })
    return true
  }
  const bytes = Buffer.from(img.data, 'base64')
  c.res.statusCode = 200
  c.res.setHeader('Content-Type', img.mediaType)
  c.res.setHeader('Content-Length', bytes.length)
  c.res.setHeader('X-Content-Type-Options', 'nosniff')
  c.res.setHeader('Cache-Control', IMAGE_CACHE)
  c.res.end(bytes)
  return true
}
