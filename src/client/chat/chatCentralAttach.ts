// How the Central chat resolves attached files. Its Claude runs without built-in tools and cannot open
// a path, so nothing is uploaded: images become pending images (sent as image blocks), UTF-8 text
// files are queued as `text/plain` items whose content the server inlines into the prompt, anything
// else is refused. One failure never drops the other files.
import {
  CENTRAL_ATTACH_KINDS_MESSAGE, CENTRAL_FILE_MAX_BYTES, isUtf8Text,
} from '../../shared/centralAttach'
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
