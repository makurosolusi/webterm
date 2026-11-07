// Attachment limits of the Central chat, shared by the composer (checks before reading a file) and the
// send route (the authority). Images reuse Agent Chat's limits (agentChat.wire.ts); text files are
// inlined into the prompt because Central's Claude runs without built-in tools and cannot open a path.

/** Bytes of one attached text file. */
export const CENTRAL_FILE_MAX_BYTES = 200 * 1024
/** Bytes of all text files of one message. */
export const CENTRAL_FILES_TOTAL_BYTES = 500 * 1024
/** Text files per message. */
export const CENTRAL_FILES_MAX = 20
/** Refusal for anything that is neither an image nor UTF-8 text. */
export const CENTRAL_ATTACH_KINDS_MESSAGE = 'Central can read text files and images only.'

/** True when `bytes` is UTF-8 text: decodes strictly and holds no NUL byte (binary files nearly always do). */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    // A decode error is the answer, not a failure.
    return false
  }
}
