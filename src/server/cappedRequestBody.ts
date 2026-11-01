// Body intake BERBATAS untuk rute `/api` yang masih membaca teks mentah: `workspaces` dan
// `settings`. Pembaca `fs`/`git` SENGAJA tidak memakai modul ini — isi file yang ditulis client
// memang boleh besar, jadi cap di sana akan memutus fitur, bukan menutup celah.
//
// Batasnya ditegakkan SAAT streaming (lewat `readCappedBody` di `channels/channelHttp`), dan
// `Content-Length` hanya dipakai sebagai tolak-cepat: body chunked tanpa header tetap dipotong di
// cap+1, jadi payload raksasa tidak pernah tertampung utuh di memori.
import type { IncomingMessage } from 'node:http'
import { declaredLength, readCappedBody } from './channels/channelHttp'

/** Hasil baca: teks body, atau alasan penolakan. Pemetaan ke status HTTP milik pemanggil. */
export type CappedBody = { ok: true; body: string } | { ok: false; reason: 'too_large' | 'read_failed' }

/** PATCH settings: puluhan kunci kecil, 64 KiB sudah jauh di atas pemakaian wajar. */
export const SETTINGS_BODY_MAX_BYTES = 64 * 1024
/** Simpan workspace: ribuan node + bridge masih di bawah 1 MiB; di atasnya bukan snapshot lagi. */
export const WORKSPACES_BODY_MAX_BYTES = 1024 * 1024

/** Method yang tidak punya body. Stream TIDAK boleh disentuh untuk method ini: menunggu `end`
 *  pada request tanpa body menggantung sampai timeout. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS'])

/**
 * Dilempar getter body (lihat `cappedBodyGetter`) supaya tabel rute yang menerima
 * `() => Promise<string>` bisa membedakan penolakan cap dari body JSON yang buruk, tanpa
 * mengubah tanda tangan getter-nya.
 */
export class BodyReadError extends Error {
  readonly reason: 'too_large' | 'read_failed'

  constructor(reason: 'too_large' | 'read_failed') {
    super(`request body ${reason}`)
    this.name = 'BodyReadError'
    this.reason = reason
  }
}

/**
 * Baca body request dengan batas keras `maxBytes`.
 *
 * `Content-Length` di atas cap ditolak TANPA membaca satu byte pun; sisa stream di-drain
 * (`resume`) supaya koneksi keep-alive tidak desync. Body chunked dipotong di cap+1 oleh
 * `readCappedBody`, yang juga men-drain sisanya.
 */
export async function readCappedRequestBody(req: IncomingMessage, maxBytes: number): Promise<CappedBody> {
  const declared = declaredLength(req.headers['content-length'])
  if (declared !== undefined && declared > maxBytes) {
    req.resume()
    return { ok: false, reason: 'too_large' }
  }
  const read = await readCappedBody(req, maxBytes)
  return read.ok ? { ok: true, body: read.body } : { ok: false, reason: read.reason }
}

/**
 * Getter malas untuk tabel rute ber-`body: () => Promise<string>`: hanya membaca stream saat
 * benar-benar dipanggil (POST/PUT), menjawab `''` untuk method tanpa body, dan melempar
 * `BodyReadError` bila cap/stream menolak. Hasilnya di-memo agar satu request tidak membaca
 * stream dua kali.
 */
export function cappedBodyGetter(req: IncomingMessage, method: string, maxBytes: number): () => Promise<string> {
  let pending: Promise<string> | null = null
  return () => {
    if (BODYLESS_METHODS.has(method)) return Promise.resolve('')
    pending ??= readCappedRequestBody(req, maxBytes).then((result) => {
      if (result.ok) return result.body
      throw new BodyReadError(result.reason)
    })
    return pending
  }
}
