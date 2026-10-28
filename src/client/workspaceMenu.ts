// Keputusan di balik menu kebab tab workspace: nama hasil rename, tab mana yang mengambil alih
// setelah sebuah workspace dihapus, dan kalimat konfirmasi hapusnya. Dipisah dari komponen dengan
// alasan yang sama seperti `workspaceTabs.ts`: vitest webterm jalan di node-env tanpa DOM, jadi
// yang bisa di-assert harus hidup di luar JSX — dan ketiga hal di sini adalah yang paling mahal
// kalau salah (hapus TIDAK bisa dibatalkan).

/**
 * Nama simpanan untuk sebuah rename, atau `null` bila draft-nya bukan nama.
 *
 * Trim bukan kosmetik: server menerima apa pun yang dikirim (`workspacesApi.ts` PUT hanya
 * memeriksa bentuk body, bukan isi `name`), jadi spasi doang akan tersimpan dan dirender sebagai
 * tab TANPA label — tab yang tidak bisa dikenali lagi, padahal menu kebab-nya satu-satunya jalan
 * untuk membetulkannya. Yang menolak ada di sini, bukan di komponen, supaya pagarnya ikut teruji.
 */
export function normalizeWorkspaceName(raw: string): string | null {
  const name = raw.trim()
  return name === '' ? null : name
}

/**
 * Workspace mana yang aktif SETELAH `deletedId` hilang: `activeId` apa adanya bila yang dihapus
 * bukan yang aktif, tab yang mengambil alih slotnya bila ya, dan `null` bila tak ada sisa sama
 * sekali (App jatuh ke layar `Welcome`).
 *
 * Aturan slot-nya disalin dari nodeterm `state/projects.ts#deleteProject`
 * (`remaining[Math.min(index, remaining.length - 1)]`): tab tetangga KANAN, kecuali yang dihapus
 * tab terakhir — maka tetangga kirinya. Pengganti tidak boleh ditebak sembarangan: `activeId` yang
 * menunjuk id mati membuat `PUT /api/active` dan `GET /api/workspaces/:id` gagal, dan canvas
 * berhenti di board yang row-nya sudah tidak ada.
 */
export function nextActiveWorkspaceId(
  ids: string[],
  deletedId: string,
  activeId: string | null,
): string | null {
  if (activeId !== deletedId) return activeId
  const index = ids.indexOf(deletedId)
  const remaining = ids.filter((id) => id !== deletedId)
  if (remaining.length === 0) return null
  // `index` bisa -1 (id tak ada di daftar) — clamp ke 0 supaya hasilnya tab pertama, bukan undefined.
  return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
}

/**
 * Kalimat konfirmasi hapus. Bentuknya mengikuti nodeterm `lib/projectCloseSessions.ts`
 * (`deleteConfirmCopy`): sebut NAMA-nya, sebut apa yang ikut berakhir, lalu tegaskan apa yang TIDAK
 * ikut terhapus — folder di disk — supaya "Delete" tidak terbaca sebagai menghapus pekerjaan.
 */
export function deleteWorkspaceMessage(name: string, sessions: number): string {
  const ends = sessions === 0 ? '' : `ends its ${sessions} session${sessions === 1 ? '' : 's'} and `
  return (
    `Delete “${name}”? This ${ends}removes the workspace from webterm, together with its saved ` +
    `board. The folder on disk is not deleted.`
  )
}
