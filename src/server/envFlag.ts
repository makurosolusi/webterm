/**
 * Dialek on/off bersama semua flag `WEBTERM_*` non-keamanan: `on|1|true` => on, `off|0|false` => off
 * (trim, case-insensitive); selain itu undefined. Dua kunci keamanan tetap `=== '1'` dan tidak lewat sini.
 */
export function parseFlag(raw: string | null | undefined): 'on' | 'off' | undefined {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
}

/** True hanya untuk on; unset, kosong, off, dan typo tetap off (fail-closed). */
export const flagOn = (raw: string | null | undefined): boolean => parseFlag(raw) === 'on'

/** Dialek kanonik dengan default pemanggil: on/off dikenali, selain itu (kosong, typo) memakai `def`. */
export const flagOr = (raw: string | null | undefined, def: boolean): boolean => {
  const v = parseFlag(raw)
  return v === undefined ? def : v === 'on'
}

/** Dua kunci keamanan (ALLOW_TOKEN_MINT, STRICT_HOOK_AUTH): persis `1`, tanpa trim/huruf. */
export const strictFlag = (raw: string | null | undefined): boolean => raw === '1'
