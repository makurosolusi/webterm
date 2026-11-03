/** MIME yang diisi file manager saat baris file di-drag; isinya path yang SUDAH dikutip shell. */
export const PATH_DROP_MIME = 'application/x-webterm-path'

type DropData = Pick<DataTransfer, 'types' | 'getData'>

/** True bila drag membawa path dari file manager kita (dipakai `dragover`, saat isi belum terbaca). */
export function isPathDrag(dt: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dt.types).includes(PATH_DROP_MIME)
}

/**
 * Teks siap-paste dari drop: path terkutip + satu spasi (tanpa newline, jadi tak pernah mengeksekusi).
 * `null` bila MIME kita tak ada/kosong; `text/plain` dari sumber luar sengaja diabaikan.
 */
export function readDroppedPath(dt: DropData): string | null {
  if (!isPathDrag(dt)) return null
  const path = dt.getData(PATH_DROP_MIME).trim()
  return path ? `${path} ` : null
}
