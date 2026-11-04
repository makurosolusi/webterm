/**
 * PII masking on memory write (global Rule 12): e-mail addresses, payment card numbers (Luhn-valid,
 * 13-19 digits) and phone numbers become fixed placeholders before a row is hashed or stored, so
 * memory, its FTS indexes and every prompt block built from it never carry them. Masking is
 * idempotent: masking masked text changes nothing, so hashes of masked text stay stable.
 */
export const PII_MASK = { email: '[email]', card: '[card]', phone: '[phone]' } as const

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu
/** A run of digits with optional single spaces/dashes/parens between them, optional leading `+`. Dots are
 *  left out on purpose: IPs and versions (`192.168.1.100`) are not PII. */
const NUMBERISH = /(?<![\p{L}\p{N}.])\+?\(?\d(?:[ ()-]{0,2}\d){8,22}(?![\p{L}\p{N}])/gu
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

function maskNumber(match: string): string {
  if (ISO_DATE.test(match)) return match
  const digits = match.replace(/\D/g, '')
  if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return PII_MASK.card
  // A bare digit run starting 1-9 is more likely an id or epoch-ms than a phone: only `+`, a leading
  // 0 (national format) or separators make it a phone.
  const phoneShaped = match.startsWith('+') || digits.startsWith('0') || /[ ()-]/.test(match)
  return digits.length >= 9 && digits.length <= 15 && phoneShaped ? PII_MASK.phone : match
}

/** Text with PII replaced by placeholders. */
export function maskPii(text: string): string {
  return text.replace(EMAIL, PII_MASK.email).replace(NUMBERISH, maskNumber)
}
