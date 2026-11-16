// Size guards for whole-file reads (files node / editor node). The server loads the payload fully
// and sends it to the browser in one shot, so an unbounded read of a huge file (a big log, a video
// opened as text) spikes memory on BOTH sides. Reads above the cap return a sentinel string
// instead of the file content.
//
// Why a sentinel and not an empty string: the editor must REFUSE to open such a file. An empty
// buffer followed by save would truncate the user's real file. The sentinel starts with a NUL byte,
// which cannot occur in valid text or base64 payloads, so consumers can detect it cheaply and
// show "file too large".
const MiB = 1024 * 1024

export const FS_READ_MAX_BYTES = 10 * MiB
export const FS_READ_BINARY_MAX_BYTES = 24 * MiB

/** Leading window inspected to classify a file as binary (a NUL byte means binary). */
export const SNIFF_BYTES = 8 * 1024

/**
 * Body limit for `/api/fs/*` JSON routes (413 `ETOOLARGE` above it): twice the read cap, because
 * JSON escaping (`\n`, `\"`, `\uXXXX`) inflates text and a file that could be opened (<= read cap)
 * must still be savable; plus a fixed 64 KiB for the wrapper fields.
 */
export const FS_BODY_MAX = FS_READ_MAX_BYTES * 2 + 64 * 1024

/** Defaults for `WEBTERM_FILES_LIST_MAX` and `WEBTERM_FILES_UPLOAD_MAX_MB`. */
export const FILES_LIST_MAX_DEFAULT = 5000
export const FILES_UPLOAD_MAX_MB_DEFAULT = 100

// Wire prefix for the sentinel. Consumers use `tooLargeSentinel` / `tooLargeSize`, never the literal.
const SENTINEL_PREFIX = '\u0000webterm:too-large:'
// legacy: pre-rename prefix, recognised only (tabs/clients not yet reloaded), never emitted.
// Remove after 0.10.0.
const SENTINEL_PREFIX_LEGACY = '\u0000nodeterm:too-large:'

/** The string returned in place of content for a file of `sizeBytes` that exceeds the cap. */
export function tooLargeSentinel(sizeBytes: number): string {
  return SENTINEL_PREFIX + String(sizeBytes)
}

/** The file size in bytes when `s` is a too-large sentinel, otherwise null. */
export function tooLargeSize(s: string): number | null {
  for (const prefix of [SENTINEL_PREFIX, SENTINEL_PREFIX_LEGACY]) {
    if (!s.startsWith(prefix)) continue
    const size = Number(s.slice(prefix.length))
    return Number.isFinite(size) ? size : null
  }
  return null
}

const BYTE_UNITS: readonly { factor: number; label: string; digits: number }[] = [
  { factor: 1024 ** 3, label: 'GB', digits: 1 },
  { factor: 1024 ** 2, label: 'MB', digits: 1 },
  { factor: 1024, label: 'KB', digits: 0 },
]

/** Short human size: `512 B`, `3 KB`, `1.5 MB`, `2.0 GB`. */
export function formatBytes(n: number): string {
  const unit = BYTE_UNITS.find((u) => n >= u.factor)
  return unit ? `${(n / unit.factor).toFixed(unit.digits)} ${unit.label}` : `${n} B`
}
