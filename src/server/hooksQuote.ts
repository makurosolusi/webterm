/** Single-quote sebuah string untuk shell POSIX (tutup-escape-buka untuk quote di dalamnya). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Encode sebuah nilai untuk query string, LEBIH KETAT dari `encodeURIComponent`.
 *
 * `encodeURIComponent` sengaja membiarkan `'`, `(`, `)`, `!`, `*` mentah. Untuk sebuah nilai yang
 * juga dilarutkan ke baris shell, `'` mentah berarti quoting URL bergantung sepenuhnya pada `shq` —
 * benar hari ini, tapi satu lapis saja. Di sini `'` (dan kawan-kawannya) dipersenkan sendiri,
 * sehingga URL-nya aman dibaca siapa pun, bahkan sebelum masuk shell.
 */
export const encodeQueryValue = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
