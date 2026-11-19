// Masking helpers for read-only surfaces that show file lines (Find in Files rows).
// Same-length output, so match columns computed on the original text stay valid.
import { detectSecrets } from '../shared/secretMask.detect'
import { hiddenState, maskText } from './secretMask.reveal'

/** One line of `path` with secret values (or the whole line for a file-wide secret file) as bullets. */
export function maskLine(path: string, text: string): string {
  return maskText(text, detectSecrets(path, text), hiddenState())
}
