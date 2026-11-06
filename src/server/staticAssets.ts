// Resolusi aset statis prod dari manifest hasil embed (distAssets.generated.ts). Pure &
// testable — tak menyentuh fs path, karena kunci manifest adalah whitelist tetap (lihat bawah).
// `serveAsset` is the one fs touch: it reads the resolved file and fails closed per request.
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { createLogger } from './logs'

const log = createLogger('static')

// Bun.file typed locally (narrow slice) like nameGen/pty: @types/bun reddens other files.
declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

/** Content-type per ekstensi. Ragam ini yang benar-benar muncul di `dist/` vite nyata. */
export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

const INDEX = '/index.html'

/**
 * URL → aset yang di-embed, atau fallback SPA ke index.html. Mengembalikan null bila manifest
 * kosong (stub pra-build). Kunci berasal dari whitelist manifest, jadi path-traversal mustahil
 * secara struktural — tak ada resolusi path fs di sini.
 */
export function resolveAsset(
  urlPath: string,
  assets: Record<string, string>
): { assetPath: string; contentType: string } | null {
  const direct = assets[urlPath]
  if (direct) {
    return { assetPath: direct, contentType: CONTENT_TYPES[path.extname(urlPath)] || 'application/octet-stream' }
  }
  // Directory index before the SPA fallback: `/m` and `/m/` serve the /m PWA page (`m/index.html`).
  const dirIndex = path.extname(urlPath) === '' ? assets[`${urlPath.replace(/\/+$/, '')}${INDEX}`] : undefined
  if (dirIndex) return { assetPath: dirIndex, contentType: 'text/html' }
  const index = assets[INDEX]
  if (!index) return null
  return { assetPath: index, contentType: 'text/html' }
}

/** A resolved asset whose file is gone (dist/ rebuilt under a running server) is a 404. */
const ASSET_MISSING_STATUS = 404
/** Any other read failure (permissions, I/O) is the server's fault. */
const ASSET_READ_FAILED_STATUS = 500

/**
 * Read `hit` from disk and answer it. Never rejects: a missing or unreadable file answers that
 * one request with 404/500 plus a warning naming the file, instead of an unhandled rejection that
 * takes the whole server (and every open terminal) down.
 */
export async function serveAsset(res: ServerResponse, hit: { assetPath: string; contentType: string }): Promise<void> {
  let buf: ArrayBuffer
  try {
    buf = await Bun.file(hit.assetPath).arrayBuffer()
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
  res.end(Buffer.from(buf))
}
