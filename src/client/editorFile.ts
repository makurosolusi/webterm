import { tooLargeSize, formatBytes } from '../shared/fsLimits'
import { fileKind } from '../shared/fileKind'

/**
 * Pure decisions for the editor node: which view a path gets, whether it opens straight into the
 * rendered Markdown preview, whether a payload from `read`/`readBinary` may be opened at all, and
 * the path arithmetic used when files are renamed or moved. Kept out of `EditorNode.tsx` so it is
 * testable in the node-env runner (importing the component would pull in Monaco, which only loads
 * under the Vite build).
 */

/** 'text' opens in Monaco; every other kind goes to `ViewerHost` (image/pdf/audio/video, placeholders for archive/binary). */
export type EditorFileKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'archive' | 'binary'

/** Backslashes count as separators so Windows-style paths behave the same. */
const toPosix = (p: string): string => p.replace(/\\/g, '/')

const withoutTrailingSlashes = (p: string): string => p.replace(/\/+$/, '')

/** Last path segment; '' for an empty path or one ending in a separator. */
export function fileBaseName(path: string): string {
  const segments = toPosix(path).split('/')
  return segments[segments.length - 1] ?? ''
}

/** Lowercase extension without the dot; '' when absent (a dotfile like `.gitignore` has none). */
export function fileExt(path: string): string {
  const name = fileBaseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Which view the editor node uses for `path`; the kind comes from `fileKind()`, shared with the server. */
export function editorFileKind(path: string): EditorFileKind {
  const kind = fileKind(path)
  return kind === 'markdown' ? 'text' : kind
}

const MARKDOWN_EXTS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdown', 'mkd'])

/** Whether `ext` (any case) names a Markdown file. */
export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTS.has(ext.toLowerCase())
}

/**
 * Whether a newly opened node starts in the rendered preview: only Markdown files, and only when
 * the setting is on (the Preview/Edit toggle behaves the same way).
 */
export function opensInPreview(ext: string, openMarkdownPreview: boolean): boolean {
  return openMarkdownPreview && isMarkdownExt(ext)
}

/**
 * Why a payload from `read`/`readBinary` must not be opened, or null when it is fine.
 *
 * This is about DATA LOSS, not performance. A file over the `fsLimits` cap comes back as a
 * too-large sentinel instead of its content; opening the node on an empty buffer would let one
 * Cmd+S overwrite the user's real file with zero bytes. So a refused payload must keep the editor
 * closed, and `EditorNode` only allows saving after a successful load.
 *
 * `allowEmpty` is for text, where an empty file is legitimate; for images and PDFs an empty payload
 * is always a failed read. `read` cannot tell "empty file" from "read failed" (both are ''), so the
 * component's save gate covers the remaining gap.
 */
export function loadRefusal(payload: string, label: string, allowEmpty = false): string | null {
  const tooBig = tooLargeSize(payload)
  if (tooBig != null) return `${label} too large to open here (${formatBytes(tooBig)}).`
  if (!payload && !allowEmpty) return `Couldn’t read this ${label.toLowerCase()}.`
  return null
}

/** Parent directory without a trailing slash; '/' for a root child; '' when there is no parent. */
export function dirName(path: string): string {
  const p = toPosix(path)
  const cut = p.lastIndexOf('/')
  if (cut > 0) return p.slice(0, cut)
  return cut === 0 && p.length > 1 ? '/' : ''
}

/** True when `path` is `root` itself or inside it, so renaming or deleting a folder affects what is open under it. */
export function isUnder(path: string, root: string): boolean {
  const base = withoutTrailingSlashes(toPosix(root))
  const p = toPosix(path)
  return p === base || p.startsWith(`${base}/`)
}

/** Where `path` ends up after `from` is renamed to `to`; null when `path` is not affected. */
export function remapPath(path: string, from: string, to: string): string | null {
  if (!isUnder(path, from)) return null
  const tail = toPosix(path).slice(withoutTrailingSlashes(toPosix(from)).length)
  return withoutTrailingSlashes(to) + tail
}
