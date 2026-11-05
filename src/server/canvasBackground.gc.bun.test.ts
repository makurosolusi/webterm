// Wallpaper GC: workspace delete drops its override + unshared image; a failed cleanup never blocks
// the delete; the startup prune removes stale overrides and orphan files. Real SQLite (:memory:)
// + temp dir, never the user's data dir.
import { afterAll, test, expect } from 'bun:test'
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CANVAS_BACKGROUND } from '../shared/canvasBackground.schema'
import { Db, openDb } from './db'
import { saveCanvasImage } from './canvasBackground.store'
import { pruneCanvasBackgrounds } from './canvasBackground.gc'
import { workspacesRoute } from './workspacesApi'

const root = mkdtempSync(join(tmpdir(), 'wt-bggc-'))
afterAll(() => fs.rm(root, { recursive: true, force: true }))
let n = 0
const freshDir = (): string => join(root, String(n++))
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // test-only
const noBody = () => Promise.resolve('')
const img = (imageId: string) => ({ ...DEFAULT_CANVAS_BACKGROUND, mode: 'image' as const, imageId })
const files = async (dir: string): Promise<string[]> => (await fs.readdir(dir).catch(() => [] as string[])).sort()

test('DELETE workspace removes its override and its unshared image file', async () => {
  const db = new Db(openDb(':memory:'))
  const dir = freshDir()
  const a = db.create('a')
  const b = db.create('b')
  const idA = await saveCanvasImage(dir, PNG, 'png')
  const idB = await saveCanvasImage(dir, PNG, 'png')
  db.saveSettings({ canvasBackgroundByWorkspace: { [a.id]: img(idA), [b.id]: img(idB) } })

  const r = await workspacesRoute(db, `/api/workspaces/${a.id}`, 'DELETE', noBody, () => dir)
  expect(r?.status).toBe(204)
  expect(db.get(a.id)).toBe(null)
  expect(Object.keys(db.getSettings().canvasBackgroundByWorkspace)).toEqual([b.id])
  expect(await files(dir)).toEqual([idB])
})

test('DELETE workspace keeps an image still referenced by the global background', async () => {
  const db = new Db(openDb(':memory:'))
  const dir = freshDir()
  const a = db.create('a')
  const id = await saveCanvasImage(dir, PNG, 'png')
  db.saveSettings({ canvasBackground: img(id), canvasBackgroundByWorkspace: { [a.id]: img(id) } })

  await workspacesRoute(db, `/api/workspaces/${a.id}`, 'DELETE', noBody, () => dir)
  expect(db.getSettings().canvasBackgroundByWorkspace).toEqual({})
  expect(await files(dir)).toEqual([id])
})

test('a failing background cleanup does not fail the workspace delete', async () => {
  const db = new Db(openDb(':memory:'))
  const dir = freshDir()
  const a = db.create('a')
  const id = await saveCanvasImage(dir, PNG, 'png')
  db.saveSettings({ canvasBackgroundByWorkspace: { [a.id]: img(id) } })
  db.saveSettings = () => { throw new Error('disk full') }

  const r = await workspacesRoute(db, `/api/workspaces/${a.id}`, 'DELETE', noBody, () => dir)
  expect(r?.status).toBe(204)
  expect(db.get(a.id)).toBe(null)
  expect(await files(dir)).toEqual([id]) // nothing removed when settings could not be written
})

test('startup prune drops stale overrides and orphan files, keeps referenced and foreign files', async () => {
  const db = new Db(openDb(':memory:'))
  const dir = freshDir()
  const live = db.create('live')
  const keepGlobal = await saveCanvasImage(dir, PNG, 'png')
  const keepLive = await saveCanvasImage(dir, PNG, 'png')
  const stale = await saveCanvasImage(dir, PNG, 'png')
  const orphan = await saveCanvasImage(dir, PNG, 'png')
  await fs.writeFile(join(dir, 'notes.txt'), 'x')
  db.saveSettings({ canvasBackground: img(keepGlobal), canvasBackgroundByWorkspace: { [live.id]: img(keepLive), gone: img(stale) } })

  const res = await pruneCanvasBackgrounds(db, new Set(db.list().map((w) => w.id)), dir)
  expect(res).toEqual({ overrides: 1, files: 2 })
  expect(Object.keys(db.getSettings().canvasBackgroundByWorkspace)).toEqual([live.id])
  expect(await files(dir)).toEqual([keepGlobal, keepLive, 'notes.txt'].sort())
})

test('startup prune tolerates a missing backgrounds dir', async () => {
  const db = new Db(openDb(':memory:'))
  db.saveSettings({ canvasBackgroundByWorkspace: { gone: DEFAULT_CANVAS_BACKGROUND } })
  const res = await pruneCanvasBackgrounds(db, new Set(), join(root, 'missing'))
  expect(res).toEqual({ overrides: 1, files: 0 })
  expect(db.getSettings().canvasBackgroundByWorkspace).toEqual({})
})
