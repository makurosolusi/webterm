// Pemilih viewer per `FileKind` (PLAN/FILEMANAGER-d.md WS-FM-06). Murni: komponen dipilih oleh `ViewerHost`.
import type { FileKind } from '../../shared/fileKind'

export type ViewerId = 'image' | 'media' | 'pdf' | 'placeholder'

/**
 * Viewer untuk `kind`. `null` = bukan urusan viewer (text/markdown tetap di editor; markdown lewat
 * jalur `openMarkdownPreview` yang sudah ada). Flag VIEWERS mati = semua non-teks jadi placeholder.
 * SVG ber-kind `image`, jadi selalu `<img>` (tidak pernah iframe/object).
 */
export function pickViewer(kind: FileKind, viewersOn: boolean): ViewerId | null {
  if (kind === 'text' || kind === 'markdown') return null
  if (!viewersOn) return 'placeholder'
  switch (kind) {
    case 'image': return 'image'
    case 'audio':
    case 'video': return 'media'
    case 'pdf': return 'pdf'
    default: return 'placeholder' // archive | binary
  }
}
