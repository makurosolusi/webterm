// Prod static assets: where the manifest comes from (`dist/` on disk, else the one embedded into a
// `--compile` binary by scripts/embedDist.ts), how a URL resolves against it, and how a hit is
// answered (cache headers, gzip/brotli). Resolution never touches an fs path: manifest keys are a
// fixed whitelist, so path traversal is structurally impossible.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type { ServerResponse } from 'node:http'
import { createLogger, type Logger } from './logs'
import { withRequestOrigin } from './staticAssets.origin'

const log = createLogger('static')

// Bun.file typed locally (narrow slice) like nameGen/pty: @types/bun reddens other files.
declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

/** Content type per extension: the set that really occurs in a vite `dist/`. */
export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}
/** Extensions worth compressing (png/woff2/ico are already compressed). */
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.map', '.ttf'])

const INDEX = '/index.html'
/** Vite writes content-hashed file names here: a name never changes content, so cache it forever. */
const HASHED_PREFIX = '/assets/'
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
/** Everything else (index.html, the /m service worker, icons): revalidate so a rebuild shows up. */
export const CACHE_REVALIDATE = 'no-cache'

export interface AssetHit { assetPath: string; contentType: string; cacheControl: string }

/** URL → manifest asset, else the SPA fallback to index.html; null when the manifest is empty. */
export function resolveAsset(urlPath: string, assets: Record<string, string>): AssetHit | null {
  const direct = assets[urlPath]
  if (direct) {
    return {
      assetPath: direct,
      contentType: CONTENT_TYPES[path.extname(urlPath)] || 'application/octet-stream',
      cacheControl: urlPath.startsWith(HASHED_PREFIX) ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
    }
  }
  // Directory index before the SPA fallback: `/m` and `/m/` serve the /m PWA page (`m/index.html`).
  const dirIndex = path.extname(urlPath) === '' ? assets[`${urlPath.replace(/\/+$/, '')}${INDEX}`] : undefined
  if (dirIndex) return { assetPath: dirIndex, contentType: 'text/html', cacheControl: CACHE_REVALIDATE }
  const index = assets[INDEX]
  if (!index) return null
  return { assetPath: index, contentType: 'text/html', cacheControl: CACHE_REVALIDATE }
}

/** Every file under `dir`, as `/`-separated paths relative to it (also used by scripts/embedDist.ts). */
export function listDistFiles(dir: string): string[] {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(d, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
  return walk(dir).map((abs) => path.relative(dir, abs).split(path.sep).join('/'))
}

/** Manifest of a built `dist/` on disk (URL path → absolute file), or null when it has no index.html. */
export function diskManifest(distDir: string): Record<string, string> | null {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) return null
  return Object.fromEntries(listDistFiles(distDir).map((rel) => [`/${rel}`, path.join(distDir, rel)]))
}

/**
 * Rejection handler for `import('./distAssets.generated')`: a module that was never generated (fresh
 * tree, no `bun run build`) is "nothing embedded"; any other failure (a broken generated file) throws on.
 */
export function noEmbeddedAssets(err: unknown): Record<string, string> {
  if ((err as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw new Error(`Cannot load the embedded UI manifest: ${err instanceof Error ? err.message : String(err)}`)
}

export type ManifestSource = 'disk' | 'embedded' | 'none'

/**
 * Prod manifest. `dist/` on disk wins, like `vite preview`: `vite build` alone is enough and a rebuild
 * never leaves a stale embedded list behind. The embedded one (gitignored, written by embedDist.ts)
 * serves a `--compile` binary with no dist/ next to it. Neither: log an error naming the fix — the
 * API still answers, but the UI would be a silent 404.
 */
export async function loadAssetManifest(
  distDir: string,
  embedded: () => Promise<Record<string, string>>,
  logger: Pick<Logger, 'info' | 'error'> = log,
): Promise<{ assets: Record<string, string>; source: ManifestSource }> {
  const disk = diskManifest(distDir)
  if (disk) {
    logger.info('static.manifest', 'Serving the UI from dist/ on disk', { source: 'disk', files: Object.keys(disk).length })
    return { assets: disk, source: 'disk' }
  }
  const assets = await embedded()
  if (Object.keys(assets).length > 0) {
    logger.info('static.manifest', 'Serving the embedded UI', { source: 'embedded', files: Object.keys(assets).length })
    return { assets, source: 'embedded' }
  }
  logger.error('static.manifest.empty', 'No built UI found: every page will answer 404. Run `vite build` (or `bun run build`), then restart.', { source: 'none', distDir: path.basename(distDir) })
  return { assets: {}, source: 'none' }
}

export type Encoding = 'br' | 'gzip'

/** Pick the encoding the client accepts, brotli first; `q=0` is a refusal (RFC 9110 §12.5.3). */
export function pickEncoding(acceptEncoding: string | undefined): Encoding | null {
  const accepted = new Set<string>()
  for (const part of (acceptEncoding ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name)
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip')) return 'gzip'
  return null
}

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)
/** Quality 5: a 7 MB chunk in ~90 ms (quality 11 takes ~7 s) at ~1.2x the size of 11. */
const BROTLI_QUALITY = 5
const compress = (buf: Buffer, enc: Encoding): Promise<Buffer> => (enc === 'br'
  ? brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
  : gzip(buf))

// Hashed assets only (content fixed by name), so the cache is bounded by the manifest and never stale.
// ponytail: compressed on first request, not at build time; precompress in the build if first loads matter.
const compressedCache = new Map<string, Promise<Buffer>>()
function compressed(hit: AssetHit, buf: Buffer, enc: Encoding): Promise<Buffer> {
  if (hit.cacheControl !== CACHE_IMMUTABLE) return compress(buf, enc)
  const key = `${enc}:${hit.assetPath}`
  let p = compressedCache.get(key)
  if (!p) {
    p = compress(buf, enc)
    compressedCache.set(key, p)
    p.catch(() => compressedCache.delete(key)) // a failed run is retried by the next request
  }
  return p
}

/** A resolved asset whose file is gone (dist/ rebuilt under a running server) is a 404. */
const ASSET_MISSING_STATUS = 404
/** Any other read failure (permissions, I/O) is the server's fault. */
const ASSET_READ_FAILED_STATUS = 500

/**
 * Read `hit` from disk and answer it, compressed when the client accepts it. Never rejects: a missing
 * or unreadable file answers that one request with 404/500 plus a warning naming the file, instead of
 * an unhandled rejection that takes the whole server (and every open terminal) down. An HTML page
 * gets its share-URL placeholder swapped for `origin` (staticAssets.origin.ts) when one is given.
 */
export async function serveAsset(res: ServerResponse, hit: AssetHit, acceptEncoding?: string, origin?: string | null): Promise<void> {
  let buf: Buffer
  try {
    buf = Buffer.from(await Bun.file(hit.assetPath).arrayBuffer())
    if (origin !== undefined && hit.contentType === 'text/html') buf = Buffer.from(withRequestOrigin(buf.toString('utf8'), origin))
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    const status = code === 'ENOENT' ? ASSET_MISSING_STATUS : ASSET_READ_FAILED_STATUS
    log.warn('static.read.failed', `Cannot read static asset ${path.basename(hit.assetPath)}`, {
      // code + basename only: the error message carries the absolute path (home dir).
      status, code, error: err instanceof Error ? err.name : typeof err,
    })
    res.statusCode = status
    res.end(status === ASSET_MISSING_STATUS ? 'not found' : 'asset read failed')
    return
  }
  res.setHeader('Content-Type', hit.contentType)
  res.setHeader('Cache-Control', hit.cacheControl)
  const compressible = COMPRESSIBLE.has(path.extname(hit.assetPath))
  if (compressible) res.setHeader('Vary', 'Accept-Encoding')
  const enc = compressible ? pickEncoding(acceptEncoding) : null
  if (enc) {
    try {
      const body = await compressed(hit, buf, enc)
      res.setHeader('Content-Encoding', enc)
      res.end(body)
      return
    } catch (err) {
      // Compression is an optimisation: answer uncompressed rather than failing the page.
      log.warn('static.compress.failed', `Cannot ${enc}-compress ${path.basename(hit.assetPath)}, sending it uncompressed`, {
        encoding: enc, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  res.end(buf)
}
