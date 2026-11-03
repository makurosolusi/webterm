// Predikat discard node browser tersembunyi (§4.7). Murni.
// Diadaptasi dari nodeterm `src/renderer/nodes/browser-discard-policy.ts` (fork BUSL-1.1, atribusi
// ke nodeterm upstream). Beda: tanpa `enabled`/`audible` (audio non-tujuan MVP; saklar = flag
// `WEBTERM_BROWSER`), ambang `discardMs` diinjeksi dari env, dan `>=` bukan `>`.

/**
 * Discard hanya bila tidak sedang memuat (replay navigasi setengah jadi), tidak dikemudikan agent
 * (lease aktif = dipakai walau tersembunyi), dan sudah tersembunyi >= `discardMs`. Pemanggil membaca
 * ulang kondisi saat timer MENYALA, bukan saat dipasang.
 */
export function shouldDiscard(i: { loading: boolean; driven: boolean; hiddenMs: number; discardMs: number }): boolean {
  return !i.loading && !i.driven && i.hiddenMs >= i.discardMs
}
