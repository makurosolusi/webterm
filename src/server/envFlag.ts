/**
 * Operator on/off switch parser shared by every `WEBTERM_*=on` feature flag: only `on`
 * (case-insensitive, surrounding whitespace ignored) enables; unset, empty, `off` and typos stay off.
 */
export function flagOn(raw: string | null | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'on'
}
