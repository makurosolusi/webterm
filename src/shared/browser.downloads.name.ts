// Safe file names for downloads: the name a page suggests is untrusted input (path traversal, control characters, clashes),
// so the stored name is rebuilt here and never trusted from the page. Pure, shared by server (rename) and client (display).

/** Longest stored file name in characters; filesystems cap a segment at 255 bytes, this keeps room for ` (n)` and multi-byte text. */
export const DOWNLOAD_NAME_MAX = 120
export const DOWNLOAD_NAME_FALLBACK = 'download'

/** Extensions that run code or install software when opened: shown with a warning, never blocked (the user chose the download). */
const RISKY_EXT = new Set([
  'app', 'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'sh', 'bash', 'zsh', 'command', 'pkg', 'dmg', 'deb', 'rpm', 'apk', 'jar',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'ps1', 'psm1', 'lnk', 'reg', 'iso', 'dll', 'workflow', 'action', 'terminal', 'scpt', 'appimage', 'run',
])

// Control characters and bidi overrides (they spoof an extension: `gpj.exe` shown as `exe.jpg`).
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g
const FORBIDDEN = /[\\/:*?"<>|]/g

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** True when opening the file would run code (by its last extension, so `a.pdf.exe` is risky). */
export const isRiskyName = (name: string): boolean => RISKY_EXT.has(extOf(name))

/** One path segment from whatever the page suggested: no separators, no traversal, no control characters, bounded, never empty. */
export function sanitizeDownloadName(suggested: string): string {
  const leaf = suggested.split(/[\\/]/).pop() ?? ''
  let name = leaf.replace(CONTROL, '').replace(FORBIDDEN, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (name === '') name = DOWNLOAD_NAME_FALLBACK
  if (name.length > DOWNLOAD_NAME_MAX) {
    const ext = extOf(name)
    const keep = ext && ext.length <= 12 ? `.${ext}` : ''
    name = name.slice(0, DOWNLOAD_NAME_MAX - keep.length) + keep
  }
  return name
}

/** `name` unless taken; then `name (1).ext`, `name (2).ext`, ... (case-insensitive: macOS and Windows volumes ignore case). */
export function uniqueDownloadName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}
