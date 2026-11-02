// Seluruh string UI section Environment (Rule 15): satu tempat, tidak ada literal di komponen.
export const ENV = {
  title: 'Environment',
  loading: 'Memuat pengaturan environment…',
  refresh: 'Segarkan',
  lockedBanner: 'Dikunci oleh WEBTERM_ENV_SETTINGS=off. Pengaturan tidak bisa diubah dari sini.',
  restartBanner: 'Perlu restart server untuk:',
  badgeRestart: 'restart',
  badgePending: 'menunggu restart',
  badgeDangerous: 'berbahaya',
  save: 'Simpan',
  reset: 'Reset',
  resetHelp: 'Reset mengembalikan ke nilai env atau default.',
  remove: 'Hapus',
  removeHelp: 'Hapus mengembalikan ke nilai env atau kosong.',
  defaultLabel: 'Default',
  none: '(kosong)',
  secretSet: 'Terisi',
  secretUnset: 'Kosong',
  secretPlaceholder: 'Nilai baru (write-only)',
  secretHint: 'Nilai tidak pernah ditampilkan kembali.',
  bootstrapOnly: 'hanya lewat env',
  dangerousNeedsRoot: 'Butuh token root untuk mengubah pengaturan ini.',
  on: 'on',
  off: 'off',
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

/** Urutan tampil group; group tak dikenal masuk sebelum bootstrap, bootstrap selalu terakhir. */
export const ENV_GROUP_ORDER = ['ledger', 'telegram', 'channels', 'central', 'orchestrator', 'memory', 'control'] as const
export const ENV_BOOTSTRAP_GROUP = 'bootstrap'

export const ENV_GROUP_LABEL: Record<string, string> = {
  ledger: 'Ledger',
  telegram: 'Telegram',
  channels: 'Kanal',
  central: 'Central',
  orchestrator: 'Orchestrator',
  memory: 'Memori',
  control: 'Kontrol',
  bootstrap: 'Bootstrap (hanya lewat env)',
}

export const ENV_SOURCE_LABEL = { override: 'override', env: 'env', default: 'default' } as const
