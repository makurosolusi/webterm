/**
 * Pure decisions behind the file-browser node, kept free of React and the DOM so the vitest
 * node-env can exercise them directly: which directory "up" goes to, what the breadcrumb bar
 * shows, what the filter matches, and what happens when a file is opened.
 *
 * Paths are absolute and `/`-separated. Windows drive paths are not interpreted (the server runs
 * on POSIX).
 */

/** One directory entry. The server mirror lives in `src/server/fsOps.ts`; the two declarations sit
 *  on either side of the HTTP boundary because `src/shared` is frozen and the client must not pull
 *  in `node:fs`. */
export interface DirEntry {
  name: string
  dir: boolean
  ignored?: boolean
}

/* --- path helpers --------------------------------------------------------------------------- */

const stripTrailingSlashes = (p: string): string => p.replace(/\/+$/, '')

const segmentsOf = (p: string): string[] => p.split('/').filter((s) => s !== '')

/** Last non-empty segment of a path, or '/' when there is none. */
export function folderTitle(path: string): string {
  const segs = segmentsOf(path)
  return segs.length ? segs[segs.length - 1] : '/'
}

/** Directory containing `p`; the root is its own parent. */
export function parentDir(p: string): string {
  const trimmed = stripTrailingSlashes(p)
  const cut = trimmed.lastIndexOf('/')
  return cut > 0 ? trimmed.slice(0, cut) : '/'
}

/** `dir` + `name`, without doubling the separator when `dir` is the root. */
export function childPath(dir: string, name: string): string {
  return stripTrailingSlashes(dir) + '/' + name
}

/** Where a "new file" lands: inside the clicked directory, or next to the clicked file. */
export function createTargetDir(path: string, isDir: boolean): string {
  return isDir ? path : parentDir(path)
}

/** Longest name segment (in UTF-8 bytes) common filesystems accept. */
const NAME_SEGMENT_MAX_BYTES = 255

const utf8 = new TextEncoder()

/**
 * Resolve a user-typed name against `baseDir`. Multi-segment relative names (`a/b.ts`) are fine;
 * creating the intermediate directories is the caller's job (see `ancestorDirs`). Returns `null`
 * for anything empty, absolute, drive-lettered, ending in a separator, containing an empty
 * segment, a NUL, an over-long segment, or a `..` segment.
 *
 * `..` is detected on both `/` and `\` so `..\x` cannot slip through; every other rule treats only
 * `/` as a separator, because a backslash is a legal filename character on POSIX.
 */
export function newEntryPath(baseDir: string, name: string): string | null {
  const typed = name.trim()
  const looksAbsolute = /^([A-Za-z]:|[\\/])/.test(typed)
  const endsWithSeparator = /[\\/]$/.test(typed)
  if (typed === '' || looksAbsolute || endsWithSeparator) return null
  if (typed.split(/[\\/]/).includes('..')) return null
  const parts = typed.split('/')
  if (typed.includes('\0')) return null
  for (const part of parts) {
    if (part === '' || utf8.encode(part).length > NAME_SEGMENT_MAX_BYTES) return null
  }
  return stripTrailingSlashes(baseDir) + '/' + typed
}

/** Absolute paths of the directories a nested name passes through, outermost first. */
export function ancestorDirs(baseDir: string, name: string): string[] {
  const dirParts = name.trim().split('/').slice(0, -1)
  let current = stripTrailingSlashes(baseDir)
  return dirParts.map((part) => (current = `${current}/${part}`))
}

/* --- breadcrumbs ---------------------------------------------------------------------------- */

/** One breadcrumb: its label and the directory a click navigates to. */
export interface Crumb {
  name: string
  path: string
}

/**
 * Breadcrumb trail for the node header. At most `max` trailing segments are kept; anything deeper
 * collapses into a single "…" crumb that still navigates (to the deepest hidden directory), and
 * the root is always the first crumb.
 */
export function breadcrumbs(path: string, max = 3): Crumb[] {
  const names = segmentsOf(path)
  const pathTo = (count: number): string => '/' + names.slice(0, count).join('/')
  const root: Crumb = { name: '/', path: '/' }
  const shown = names.length > max ? names.length - max : 0
  const visible = names.slice(shown).map((name, i) => ({ name, path: pathTo(shown + i + 1) }))
  return shown === 0 ? [root, ...visible] : [root, { name: '…', path: pathTo(shown) }, ...visible]
}

/* --- empty listings ------------------------------------------------------------------------- */

export type EmptyListingVerdict = 'empty' | 'missing' | 'unreachable' | 'unknown'

/**
 * Interpret an empty directory listing. The listing API swallows errors and returns `[]`, so a
 * deleted directory looks identical to an empty one, and an `exists` check cannot tell an
 * unreadable directory apart either. The parent's listing is the tie-breaker:
 *
 *  - `empty`       the parent lists us (or we are the root): the directory exists and is empty.
 *  - `missing`     the parent has entries but none is us. The only verdict that justifies an
 *                  error state.
 *  - `unreachable` the parent listing is empty or unreadable, which cannot be true if it contains
 *                  us, so the filesystem itself is out of reach.
 *  - `unknown`     the path shape means no parent listing could ever mention us; callers should
 *                  treat this as plain "empty" rather than risk a false "folder deleted".
 *
 * Matching is by name only (a symlinked directory can show up as a non-directory entry) and falls
 * back to a case-insensitive comparison for case-folding filesystems.
 */
export function classifyEmptyListing(
  cwd: string,
  /** The parent's entries, or `null` when they were not fetched or could not be read. */
  parentEntries: readonly { name: string }[] | null
): EmptyListingVerdict {
  const name = folderTitle(cwd)
  if (name === '/' || stripTrailingSlashes(cwd) === '') return 'empty'

  // Shapes a parent listing can never contain: non-absolute paths (the server expands `~`, so the
  // listing works but the parent is '/'), `.`/`..` segments (readdir never emits them), and
  // `.git` (filtered out by the listing code).
  const unlistable = !cwd.startsWith('/') || name === '.' || name === '..' || name === '.git'
  if (unlistable) return 'unknown'

  if (!parentEntries?.length) return 'unreachable'
  const folded = name.toLowerCase()
  const listed = parentEntries.some((e) => e.name === name || e.name.toLowerCase() === folded)
  return listed ? 'empty' : 'missing'
}

/* --- filtering ------------------------------------------------------------------------------ */

/**
 * Case-insensitive substring filter. A blank query returns every entry, so clearing the filter box
 * never leaves the listing hidden.
 */
export function filterEntries<T extends { name: string }>(entries: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  return needle === '' ? entries.slice() : entries.filter((e) => e.name.toLowerCase().includes(needle))
}

/* --- open target ---------------------------------------------------------------------------- */

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'weba']
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])

// Formats only the host OS can do anything useful with (installers, archives, databases, binaries
// and media). Everything else opens as a preview/editor node.
const OS_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([
  'dmg', 'pkg', 'app', 'exe', 'msi', 'deb', 'rpm', 'iso',
  'zip', 'gz', 'tar', 'tgz', 'rar', '7z',
  'sqlite', 'db', 'bin', 'dat', 'wasm',
  ...MEDIA_EXTENSIONS,
])

/** Lowercased extension of a single path segment ('' for none; a leading dot is not an extension). */
function extensionOf(segment: string): string {
  const at = segment.lastIndexOf('.')
  return at > 0 ? segment.slice(at + 1).toLowerCase() : ''
}

/** Whether the file name has a video or audio extension. */
export function isMediaFile(path: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(segmentsOf(path).pop() ?? ''))
}

/**
 * Whether a file belongs in an editor/preview node. Every segment is inspected, not only the
 * basename, so files inside an OS bundle or archive-like directory (`Thing.app/Contents/Info`)
 * are excluded too.
 */
export function opensInEditor(path: string): boolean {
  return !segmentsOf(path.replaceAll('\\', '/')).some((seg) => OS_ONLY_EXTENSIONS.has(extensionOf(seg)))
}

/**
 * What opening a file should do: `canvas` opens a node on the board (editor, image or media
 * player); `os` means "cannot be opened from here". In a browser tab the server machine's default
 * apps are unreachable, so `os` is a verdict the caller reports to the user, not an action.
 */
export function fileOpenTarget(path: string): 'canvas' | 'os' {
  return isMediaFile(path) || opensInEditor(path) ? 'canvas' : 'os'
}

/**
 * When `to` is a strict ancestor of `from`, the entry of `to` on the way down to `from` (so going
 * up can re-select the folder just left). `null` otherwise: descending, sideways, or mixed
 * absolute/relative paths.
 */
export function childOnPath(to: string, from: string): string | null {
  if (to.startsWith('/') !== from.startsWith('/')) return null
  const upper = segmentsOf(to)
  const lower = segmentsOf(from)
  const isPrefix = upper.every((seg, i) => seg === lower[i])
  return lower.length > upper.length && isPrefix ? lower[upper.length] : null
}
