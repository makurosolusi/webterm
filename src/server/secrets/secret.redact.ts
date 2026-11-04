// Output masking for the secret broker: the agent sees what a command printed, never a secret value.
// Imitates the GitHub Actions runner secret masker (actions/runner src/Runner.Common/Util/ValueEncoders.cs):
// every registered value is masked raw and in its encoded forms (base64 at the three byte alignments,
// trimmed of the alignment-dependent edge char; URI and JSON escapes), longest first.
import { REDACTED, redactSecrets } from '../redactSecrets'

/** Variants shorter than this are not masked (they would blank unrelated output); values are >= SECRET_VALUE_MIN. */
const VARIANT_MIN = 6

/** Base64 of `bytes[shift..]`, cut to the chars that do not depend on the bytes around the value (runner `Base64StringEscapeShift`). */
function base64Shift(bytes: Buffer, shift: number): string[] {
  if (bytes.length <= shift) return []
  const b64 = bytes.subarray(shift).toString('base64')
  const trimmed = b64.endsWith('==') ? b64.slice(0, -3) : b64.endsWith('=') ? b64.slice(0, -2) : b64
  return [trimmed, trimmed.replace(/\+/g, '-').replace(/\//g, '_')]
}

/** Every form of `value` that is masked in output. */
export function maskVariants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  const out = new Set<string>([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
  for (const shift of [0, 1, 2]) for (const v of base64Shift(bytes, shift)) out.add(v)
  return [...out].filter((v) => v.length >= VARIANT_MIN).sort((a, b) => b.length - a.length)
}

/** `text` with every form of every value masked, then the server-wide credential scrubber. */
export function maskSecrets(text: string, values: readonly string[]): string {
  let out = text
  const variants = [...new Set(values.flatMap(maskVariants))].sort((a, b) => b.length - a.length)
  for (const v of variants) out = out.split(v).join(REDACTED)
  return redactSecrets(out)
}
