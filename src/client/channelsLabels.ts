// Teks galat klien API channel (Rule 15). Section Channels sudah dihapus (ENVSIMPLE D6); sisa ini
// hanya dipakai `channelsApi.ts` (kartu Telegram) untuk memetakan galat ke kalimat Indonesia.
export const CH = {
  projectIdInvalid: 'Project ID wajib diisi, maksimal 200 karakter, tanpa karakter kontrol.',
  errNetwork: 'Tidak bisa menghubungi server.',
  errAuth: 'Tidak diizinkan. Muat ulang halaman dan masuk lagi.',
  errGeneric: 'Permintaan gagal. Coba lagi.',
  errGroupRole: 'Chat grup hanya boleh role viewer atau operator.',
  errInvalid: 'Input ditolak server.',
  errGone: 'Data sudah tidak ada.',
} as const
