// One rule for a new folder's name, shared by the folder picker (blocks before sending) and the
// server op that creates it (final guard).

/** NAME_MAX on Linux and macOS (bytes, not characters). */
export const FOLDER_NAME_MAX_BYTES = 255

/** Why `name` cannot be a new folder's name, or null when it can. One path segment only. */
export function folderNameError(name: string): string | null {
  if (name === '') return 'Enter a folder name.'
  if (name.trim() !== name) return 'A folder name cannot start or end with a space.'
  if (name === '.' || name === '..') return 'A folder name cannot be "." or "..".'
  if (/[/\\\x00]/.test(name)) return 'A folder name cannot contain "/", "\\" or a NUL character.'
  if (new TextEncoder().encode(name).length > FOLDER_NAME_MAX_BYTES) return `A folder name can be at most ${FOLDER_NAME_MAX_BYTES} bytes.`
  return null
}
