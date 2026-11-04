// Resolusi aset statis prod dari manifest hasil embed (distAssets.generated.ts). Pure &
// testable — tak menyentuh fs path, karena kunci manifest adalah whitelist tetap (lihat bawah).
import path from 'node:path'

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
