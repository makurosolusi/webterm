// ops-212-2: the documented prod path (`vite build`, then `NODE_ENV=production bun src/server/index.ts`)
// must serve the UI from dist/ on disk, an empty manifest must log an error instead of a silent 404,
// and the build must not rewrite a tracked file (the generated manifest is gitignored, untracked).
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAssetManifest, noEmbeddedAssets, resolveAsset } from './staticAssets'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fakeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'wt-dist-'))
  dirs.push(dist)
  mkdirSync(join(dist, 'assets'))
  mkdirSync(join(dist, 'm'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html>app')
  writeFileSync(join(dist, 'assets', 'main-abc123.js'), 'console.log(1)')
  writeFileSync(join(dist, 'm', 'index.html'), '<!doctype html>m')
  return dist
}

function recorder(): { info: (e: string) => void; error: (e: string) => void; events: string[] } {
  const events: string[] = []
  return { events, info: (e) => void events.push(`info:${e}`), error: (e) => void events.push(`error:${e}`) }
}

const noEmbedded = async (): Promise<Record<string, string>> => ({})

test('a built dist/ on disk is served with no embed step', async () => {
  const dist = fakeDist()
  const log = recorder()
  const { assets, source } = await loadAssetManifest(dist, noEmbedded, log)
  expect(source).toBe('disk')
  expect(resolveAsset('/', assets)?.assetPath).toBe(join(dist, 'index.html'))
  expect(resolveAsset('/assets/main-abc123.js', assets)?.assetPath).toBe(join(dist, 'assets', 'main-abc123.js'))
  expect(resolveAsset('/m/', assets)?.assetPath).toBe(join(dist, 'm', 'index.html'))
  expect(log.events).toEqual(['info:static.manifest'])
})

test('dist/ wins over a stale embedded manifest', async () => {
  const dist = fakeDist()
  const { source } = await loadAssetManifest(dist, async () => ({ '/index.html': '/old/index.html' }), recorder())
  expect(source).toBe('disk')
})

test('no dist/ falls back to the embedded manifest (the --compile binary)', async () => {
  const embedded = { '/index.html': '/$bunfs/root/index.html' }
  const { assets, source } = await loadAssetManifest(join(tmpdir(), 'wt-no-such-dist'), async () => embedded, recorder())
  expect(source).toBe('embedded')
  expect(assets).toEqual(embedded)
})

test('no UI at all logs an error at boot instead of a silent 404', async () => {
  const log = recorder()
  const { assets, source } = await loadAssetManifest(join(tmpdir(), 'wt-no-such-dist'), noEmbedded, log)
  expect(source).toBe('none')
  expect(assets).toEqual({})
  expect(log.events).toEqual(['error:static.manifest.empty'])
})

test('a never-generated embedded module is "nothing embedded"; a broken one still throws', () => {
  expect(noEmbeddedAssets(Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }))).toEqual({})
  let message = ''
  try { noEmbeddedAssets(new SyntaxError('Unexpected token')) } catch (err) { message = (err as Error).message }
  expect(message).toMatch(/embedded UI manifest: Unexpected token/)
})

test('the generated manifest is gitignored and untracked, so a build leaves the tree clean', () => {
  const rel = 'src/server/distAssets.generated.ts'
  const repo = join(import.meta.dirname, '../..')
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  expect(git('check-ignore', '--no-index', rel)).toBe(rel)
  // Index, not HEAD: a tracked copy is what `bun run build` would show as modified.
  expect(git('ls-files', '--', rel)).toBe('')
})
