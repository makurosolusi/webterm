// Inline project-name check; same rule as the server's isSafeFolderName (the server stays the
// authority) so a name this accepts is never refused for its shape. Edge spaces are trimmed, not errors.
import { CREATE_TEXT } from './workspaceCreate.labels'

const MAX_FOLDER_NAME = 255

/** Human reason the trimmed name is unusable, or '' when it is fine (or still empty: see `required`). */
export function projectNameError(raw: string, required = false): string {
  const name = raw.trim()
  if (name === '') return required ? CREATE_TEXT.name.empty : ''
  if (name === '.' || name === '..') return CREATE_TEXT.name.dots
  if (/[\\/]/.test(name)) return CREATE_TEXT.name.slash
  if (/[\x00-\x1f]/.test(name)) return CREATE_TEXT.name.control
  if (name.length > MAX_FOLDER_NAME) return CREATE_TEXT.name.long
  return ''
}
