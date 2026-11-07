// Attachment limits of the Central chat, shared by the composer (checks before reading a file) and the
// send route (the authority). Images reuse Agent Chat's limits (agentChat.wire.ts); text files are
// inlined into the prompt because Central's Claude runs without built-in tools and cannot open a path.

/** Bytes of one attached text file. */
export const CENTRAL_FILE_MAX_BYTES = 200 * 1024
/** Bytes of all text files of one message. */
export const CENTRAL_FILES_TOTAL_BYTES = 500 * 1024
/** Text files per message. */
export const CENTRAL_FILES_MAX = 20
/**
 * Base64 chars of all images of one message. Claude Code caps piped stdin at 10 MB (code.claude.com
 * docs/en/headless, "Piped stdin is capped at 10MB") and nothing documented exempts `--input-format
 * stream-json`, where the images travel. 8 MiB of base64 (6 MiB of image bytes) leaves room in that one
 * JSONL line for the prompt and up to CENTRAL_FILES_TOTAL_BYTES of inlined text, JSON-escaped.
 * Agent Chat's caps (AGENT_CHAT_IMAGES_TOTAL_B64) are unchanged: it goes through the Agent SDK.
 */
export const CENTRAL_IMAGES_TOTAL_B64 = 8 * 1024 * 1024
/** Refusal for images over CENTRAL_IMAGES_TOTAL_B64, shared by composer and route. */
export const centralImagesTooLarge = (): string =>
  `Images are over ${CENTRAL_IMAGES_TOTAL_B64 / 1024 / 1024} MB in total, the most Central can send to Claude at once. Remove some and send again.`
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
