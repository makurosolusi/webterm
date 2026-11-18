// Canvas wallpaper garbage collection: a stored image file is deleted once no background in
// settings references it. Used by the image routes (replace/clear), by workspace delete (drop
// that workspace's override) and once at server start (prune overrides of vanished workspaces
// and orphan files left by crashes or older versions).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../shared/settings'
import { CANVAS_IMAGE_ID_RE, referencedImageIds } from '../shared/canvasBackground.schema'
import { backgroundsDir, CANVAS_PARTIAL_RE, deleteCanvasImage } from './canvasBackground.store'
import { createLogger } from './logs'
import type { SettingsStore } from './settingsApi'

const log = createLogger('canvas-background')

/** Delete image `id` from `dir` unless `settings` still references it. */
export async function deleteIfUnreferenced(dir: string, settings: Settings, id: string): Promise<void> {
  if (id && !referencedImageIds(settings).has(id)) await deleteCanvasImage(dir, id)
}

/**
 * Remove workspace `workspaceId`'s wallpaper override and its image file (when unshared). Never
 * throws: a failed cleanup must not fail the workspace delete, so it is logged as a warning.
 * `dir` is lazy so a workspace without override never touches the data dir.
 */
export async function dropWorkspaceBackground(store: SettingsStore, workspaceId: string, dir: () => string = backgroundsDir): Promise<void> {
  try {
    const current = store.getSettings()
    const old = current.canvasBackgroundByWorkspace[workspaceId]
    if (!old) return
    const saved = store.saveSettings({ canvasBackgroundByWorkspace: { [workspaceId]: null } }) // entry patch: null deletes
    await deleteIfUnreferenced(dir(), saved, old.imageId)
  } catch (err) {
    log.warn('canvas-background.gc_failed', `Cannot clean canvas background of deleted workspace ${workspaceId}`, { cause: (err as Error)?.message ?? String(err) })
  }
}

/**
 * One-shot startup prune: drop overrides whose workspace no longer exists, then delete image files
 * in `dir` that no background references. Bounded by one settings write and one `readdir`.
 * Throws with context on failure; the caller decides (startup logs a warning and keeps booting).
 */
export async function pruneCanvasBackgrounds(store: SettingsStore, workspaceIds: ReadonlySet<string>, dir: string): Promise<{ overrides: number; files: number }> {
  let settings = store.getSettings()
  const byWs = settings.canvasBackgroundByWorkspace
  const stale = Object.keys(byWs).filter((id) => !workspaceIds.has(id))
  if (stale.length) {
    settings = store.saveSettings({ canvasBackgroundByWorkspace: Object.fromEntries(stale.map((id) => [id, null])) })
  }
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { overrides: stale.length, files: 0 }
    throw new Error(`prune canvas backgrounds: read ${dir} failed: ${(err as Error).message}`, { cause: err })
  }
  // ponytail: an upload racing this prune (file written, settings not yet) could lose its file;
  // runs once at boot before clients reconnect, so the window is negligible. Add an mtime grace if not.
  const referenced = referencedImageIds(settings)
  const orphans = names.filter((n) => CANVAS_IMAGE_ID_RE.test(n) && !referenced.has(n))
  for (const n of orphans) await deleteCanvasImage(dir, n)
  // `.part` = an upload a crash interrupted (a live upload is renamed within the same request, and
  // boot runs before clients reconnect). Not an image id, so deleteCanvasImage would ignore it.
  const partials = names.filter((n) => CANVAS_PARTIAL_RE.test(n))
  for (const n of partials) await fs.rm(join(dir, n), { force: true })
  return { overrides: stale.length, files: orphans.length + partials.length }
}
