// How the agent chat resolves attached files: an image type Claude takes becomes a pending image
// (sent as an image block); any other file is staged on the server and its path goes into the draft,
// One failure never drops the other files.
import { isClaudeImage, prepareImage, uploadNameFor, type ComposerImage } from '../chat/chatAttach'
import type { AttachFiles } from '../chat/chatComposerAttach'
import type { AgentChatTransport } from './agentChatTransport'

/** Staged names are [A-Za-z0-9._-] (server side); only a data dir with spaces needs quotes. */
const quoted = (path: string): string => (/\s/.test(path) ? `"${path}"` : path)
const reason = (err: unknown): string => (err instanceof Error ? err.message : 'unknown error')

export function agentChatAttach(transport: Pick<AgentChatTransport, 'upload'>): AttachFiles {
  return async (files) => {
    // Resolved in parallel, collected in the order the files came.
    const done = await Promise.all(files.map(async (file): Promise<{ image?: ComposerImage; path?: string; failed?: string }> => {
      const name = uploadNameFor(file)
      try {
        return isClaudeImage(file) ? { image: await prepareImage(file) } : { path: await transport.upload(file, name) }
      } catch (err) {
        return { failed: `${name}: ${reason(err)}` }
      }
    }))
    const paths = done.flatMap((d) => (d.path ? [quoted(d.path)] : []))
    return {
      images: done.flatMap((d) => (d.image ? [d.image] : [])),
      text: paths.length ? `${paths.join(' ')} ` : '',
      failed: done.flatMap((d) => (d.failed ? [d.failed] : [])),
    }
  }
}
