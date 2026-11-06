// Canvas wallpaper image routes. Behind the same root-token gate as every /api path (index.ts):
//   POST   /api/canvas-background/image[?workspace=<id>]  raw image body -> saved Settings
//   DELETE /api/canvas-background/image[?workspace=<id>]  clear the image  -> saved Settings
//   GET    /api/canvas-background/image/<uuid>.<ext>       the stored bytes
// Upload and delete also write the settings, so the image id and the file can never disagree, and
// the replaced file is removed once nothing in settings references it any more.
import type { ServerResponse } from 'node:http'
import type { Settings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings.patch'
import {
  DEFAULT_CANVAS_BACKGROUND, WORKSPACE_BACKGROUNDS_LIMITS, type CanvasBackground,
} from '../../shared/canvasBackground.schema'
import {
  backgroundsDir, MAX_CANVAS_IMAGE_BYTES, readBinaryBody, readCanvasImage, saveCanvasImage, sniffImage,
} from '../canvasBackground.store'
import { deleteIfUnreferenced } from '../canvasBackground.gc'
import { createLogger } from '../logs'
import type { SettingsStore } from '../settingsApi'
import { json, type ApiRoute, type RouteCtx } from './route.core'

const log = createLogger('canvas-background')

export const CANVAS_IMAGE_PATH = '/api/canvas-background/image'

/** Injected so tests run against a temp dir and an in-memory store. */
export interface CanvasBackgroundDeps {
  store: SettingsStore
  dir: string
}

/** The background a scope currently has (a workspace without override starts from global). */
function scopeBackground(s: Settings, workspace: string | null): CanvasBackground {
  if (!workspace) return s.canvasBackground
  return s.canvasBackgroundByWorkspace[workspace] ?? s.canvasBackground ?? DEFAULT_CANVAS_BACKGROUND
}

/** One-entry patch for the scope (`settings.patch.ts`): other workspaces' overrides are not sent. */
function patchFor(workspace: string | null, bg: CanvasBackground): SettingsPatch {
  return workspace ? { canvasBackgroundByWorkspace: { [workspace]: bg } } : { canvasBackground: bg }
}

/**
 * Save `next(current)` for the scope, then delete the image it replaced unless still referenced.
 * `current` is read HERE, after the caller's awaits (body read, file write), never before them: a
 * concurrent upload to the same scope may have committed meanwhile, and the GC must delete the
 * image this write actually replaces, or that one is orphaned. Read and save are synchronous, so
 * nothing interleaves between them.
 */
async function commit(deps: CanvasBackgroundDeps, workspace: string | null, next: (current: CanvasBackground) => CanvasBackground): Promise<Settings> {
  const before = scopeBackground(deps.store.getSettings(), workspace)
  const saved = deps.store.saveSettings(patchFor(workspace, next(before)))
  await deleteIfUnreferenced(deps.dir, saved, before.imageId)
  return saved
}

/** Handle one canvas-background request; false = not this route. */
export async function canvasBackgroundRoute(c: Pick<RouteCtx, 'req' | 'res' | 'url' | 'path' | 'method'>, deps: CanvasBackgroundDeps): Promise<boolean> {
  const { res } = c
  if (c.path.startsWith(`${CANVAS_IMAGE_PATH}/`)) {
    if (c.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true }
    const img = await readCanvasImage(deps.dir, c.path.slice(CANVAS_IMAGE_PATH.length + 1))
    if (!img) { json(res, 404, { error: 'not found' }); return true }
    serveImage(res, img.bytes, img.type)
    return true
  }
  if (c.path !== CANVAS_IMAGE_PATH) return false
  const workspace = c.url.searchParams.get('workspace') || null
  if (workspace && workspace.length > WORKSPACE_BACKGROUNDS_LIMITS.idLength) { json(res, 400, { error: 'invalid workspace' }); return true }
  if (c.method === 'POST') {
    const body = await readBinaryBody(c.req, MAX_CANVAS_IMAGE_BYTES)
    if (body === 'too_large') { json(res, 413, { error: 'payload_too_large', maxBytes: MAX_CANVAS_IMAGE_BYTES }); return true }
    const ext = sniffImage(body)
    if (!ext) { json(res, 415, { error: 'unsupported_image', accepted: ['png', 'jpeg', 'webp', 'gif'] }); return true }
    const id = await saveCanvasImage(deps.dir, body, ext)
    const saved = await commit(deps, workspace, (b) => ({ ...b, mode: 'image', imageId: id }))
    log.info('canvas-background.upload', 'Canvas background image stored', { bytes: body.length, ext, scope: workspace ? 'workspace' : 'global' })
    json(res, 200, saved)
    return true
  }
  if (c.method === 'DELETE') {
    const saved = await commit(deps, workspace, (b) => ({ ...b, mode: b.mode === 'image' ? 'default' : b.mode, imageId: '' }))
    json(res, 200, saved)
    return true
  }
  json(res, 405, { error: 'method not allowed' })
  return true
}

function serveImage(res: ServerResponse, bytes: Buffer, type: string): void {
  res.statusCode = 200
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', String(bytes.length))
  // Ids are immutable (a replacement gets a new id), so the browser may cache forever.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(bytes)
}

/** Production wiring: the real settings store and `<dataDir>/backgrounds`. */
export function canvasBackgroundRoutes(store: SettingsStore): ApiRoute[] {
  return [{
    name: 'canvas-background',
    match: (c) => c.path === CANVAS_IMAGE_PATH || c.path.startsWith(`${CANVAS_IMAGE_PATH}/`),
    handle: (c) => canvasBackgroundRoute(c, { store, dir: backgroundsDir() }),
  }]
}
