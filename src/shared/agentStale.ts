// Jam untuk status agent — dan ia yang membuat setiap salah-angkat ke `working` jadi SEMENTARA.
//
// Status webterm hanya bisa turun kalau ada hook yang menyuruhnya turun. Tidak ada sweep, tidak ada
// jam, jadi status yang ditulis TERAKHIR bertahan selamanya. Dan ada kelas keluar yang memang tidak
// pernah mengirim event penutup: Esc di tengah tool call (hook `Stop` claude tidak pernah jalan),
// CLI dibunuh, mesin di-sleep, koneksi putus. Tanpa jam, node seperti itu membaca RUNNING selamanya
// — dan dua bug status yang sudah kami temukan ketemu hanya karena kebetulan terlihat.
//
// Jendela dan predikat murni (`WORKING_STALE_MS`, `isStaleWorking`, `now` di-inject). Keputusan
// disengaja: node basi MENGHAPUS statusnya, bukan memancarkan "end edge" sintetis. Sebab
// `'done'` di webterm menggerbangi tombol Resume/Restart (`canResumeNode`, `src/client/AgentNode.tsx`),
// jadi mengklaim `done` berarti membuka tombol di atas tebakan. Node tanpa status dirender "Unknown",
// dan "kami belum tahu" memang jawaban yang benar di sini — `undefined` memang hasil yang diuji.

/**
 * Berapa lama sebuah node `working` boleh diam tanpa event apa pun sebelum dianggap sudah hilang.
 *
 * Jauh melewati jeda nyata antar hook event — tool Bash claude tertutup di sekitar 10 menit, dan
 * SETIAP tool call me-refresh entry-nya — jadi turn yang benar-benar panjang tidak pernah tersapu.
 * Sapuan ini juga self-healing: satu event berikutnya menaruh node itu kembali ke `working`.
 */
export const WORKING_STALE_MS = 20 * 60_000

/**
 * Jarak antar sapuan. Jam dinding, bukan presisi — jendelanya 20 menit, jadi lag deteksi 1 menit
 * tidak berarti apa-apa.
 */
export const STALE_SWEEP_MS = 60_000

/**
 * Sudahkah sebuah node `working` diam lebih lama dari jendela? Murni; `now` di-inject.
 *
 * HANYA `working` yang basi. `waiting`/`blocked`/`done` menghitung tanpa batas: ketiganya menyatakan
 * sesuatu yang sudah SELESAI terjadi, dan fakta itu tidak kedaluwarsa — sebuah node yang menunggu
 * jawabanmu semalaman tetap menunggu jawabanmu. (Dibuktikan di tes pada `10 * WORKING_STALE_MS`.)
 */
export function isStaleWorking(
  status: string | undefined,
  updatedAt: number,
  now: number,
  staleMs: number = WORKING_STALE_MS
): boolean {
  return status === 'working' && now - updatedAt > staleMs
}
