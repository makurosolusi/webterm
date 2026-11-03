/**
 * Dialek on/off bersama semua flag `WEBTERM_*` non-keamanan: `on|1|true` => on, `off|0|false` => off
 * (trim, case-insensitive); selain itu undefined. Tiga kunci keamanan tetap `=== '1'` dan tidak lewat sini.
 */
export function parseFlag(raw: string | null | undefined): 'on' | 'off' | undefined {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
}

/** True hanya untuk on; unset, kosong, off, dan typo tetap off (fail-closed). */
export const flagOn = (raw: string | null | undefined): boolean => parseFlag(raw) === 'on'
