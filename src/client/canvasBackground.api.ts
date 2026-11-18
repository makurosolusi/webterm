// Client side of the canvas wallpaper image routes (src/server/routes/canvasBackground.routes.ts).
import { mergeSettings, type Settings } from '../shared/settings'
import { MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES } from '../shared/canvasBackground.schema'

const IMAGE_PATH = '/api/canvas-background/image'
const MIB = 1024 * 1024

/** Shown when an image exceeds the upload cap (client pre-check and server 413). */
export const IMAGE_TOO_LARGE_MESSAGE = `Image is too large (max ${MAX_CANVAS_IMAGE_BYTES / MIB} MB).`
export const VIDEO_TOO_LARGE_MESSAGE = `Video is too large (max ${MAX_CANVAS_VIDEO_BYTES / MIB} MB). Try a shorter loop or a lower resolution.`

const withQuery = (path: string, params: Record<string, string>): string => {
  const q = new URLSearchParams(params).toString()
  return q ? `${path}?${q}` : path
}

const scope = (workspaceId: string | null): Record<string, string> => (workspaceId ? { workspace: workspaceId } : {})

/** URL of a stored wallpaper file. Same-origin: the UI session cookie authenticates `<img>`, CSS and `<video>` alike. */
export function canvasImageUrl(imageId: string): string {
  return withQuery(`${IMAGE_PATH}/${encodeURIComponent(imageId)}`, {})
}

/** Human message for an upload failure status. */
export function uploadErrorMessage(status: number): string {
  if (status === 413) return `File is too large (images up to ${MAX_CANVAS_IMAGE_BYTES / MIB} MB, videos up to ${MAX_CANVAS_VIDEO_BYTES / MIB} MB).`
  if (status === 415) return 'Unsupported file. Use PNG, JPEG, WebP, GIF, MP4 or WebM.'
  return `Upload failed (HTTP ${status}).`
}

async function settingsFrom(res: Response, op: string): Promise<Settings> {
  if (!res.ok) throw new Error(op === 'upload' ? uploadErrorMessage(res.status) : `Removing the image failed (HTTP ${res.status}).`)
  return mergeSettings(await res.json())
}

/** Upload an image for the scope (null = global); resolves to the saved settings. */
export async function uploadCanvasImage(file: Blob, workspaceId: string | null): Promise<Settings> {
  const res = await fetch(withQuery(IMAGE_PATH, scope(workspaceId)), { method: 'POST', body: file })
  return settingsFrom(res, 'upload')
}

/** Remove the scope's image (server deletes the file); resolves to the saved settings. */
export async function removeCanvasImage(workspaceId: string | null): Promise<Settings> {
  const res = await fetch(withQuery(IMAGE_PATH, scope(workspaceId)), { method: 'DELETE' })
  return settingsFrom(res, 'remove')
}
