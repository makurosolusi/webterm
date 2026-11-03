// Teks galat klien API pengaturan env (Rule 15). Tampilan Environment sudah dihapus (ENVSIMPLE D6);
// sisa ini hanya dipakai `envSettingsApi.ts` untuk memetakan galat ke kalimat Indonesia.
export const ENV = {
  errNetwork: 'Tidak bisa menghubungi server.',
  errAuth: 'Tidak diizinkan. Muat ulang halaman dan masuk lagi.',
  errTokenRequired: 'Butuh token root untuk mengubah pengaturan ini.',
  errLocked: 'Pengaturan dikunci oleh WEBTERM_ENV_SETTINGS=off.',
  errTooLarge: 'Permintaan terlalu besar.',
  errStore: 'Server gagal menyimpan perubahan. Tidak ada yang berubah.',
  errInvalid: 'Nilai ditolak server',
  errRejected: 'Permintaan ditolak server.',
  errGeneric: 'Permintaan gagal. Coba lagi.',
} as const
