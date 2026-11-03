// Seluruh string UI section Channels (Rule 15): satu tempat, tidak ada literal di komponen.
export const CH = {
  title: 'Channels',
  loading: 'Memuat status channel…',
  refresh: 'Segarkan',
  refreshing: 'Menyegarkan…',
  inactiveTitle: 'Channel Telegram nonaktif',
  inactiveHint: 'Nyalakan Telegram dan isi Token bot di bagian ini, lalu restart server.',
  configHeading: 'Konfigurasi',
  configTitle: 'Telegram',
  statusHeading: 'Status',
  mode: 'Mode',
  modePoll: 'poll (long polling)',
  modeWebhook: 'webhook',
  botToken: 'Token bot',
  webhookSecret: 'Rahasia webhook',
  set: 'Terpasang',
  unset: 'Belum dipasang',
  ingress: 'Masuk',
  egress: 'Keluar',
  lastOk: 'terakhir OK',
  never: 'belum pernah',
  okCount: 'OK',
  errorCount: 'error',
  lastError: 'error terakhir',
  pendingHeading: 'Menunggu tautan',
  pendingEmpty: 'Tidak ada chat yang menunggu. Kirim pesan ke bot untuk melihatnya di sini.',
  pendingHint: 'Chat yang menghubungi bot tapi belum tertaut. Bot tidak membalas chat ini sampai ditautkan.',
  messages: 'pesan',
  lastSeen: 'terakhir terlihat',
  role: 'Role',
  projectId: 'Project ID',
  projectIdPlaceholder: 'project id',
  projectIdInvalid: 'Project ID wajib diisi, maksimal 200 karakter, tanpa karakter kontrol.',
  bind: 'Tautkan',
  ignore: 'Abaikan',
  bindingsHeading: 'Tautan aktif',
  bindingsEmpty: 'Belum ada chat yang tertaut.',
  remove: 'Hapus',
  removeTitle: 'Hapus tautan?',
  removeDescription: 'Chat ini tidak akan bisa lagi memakai bot sampai ditautkan ulang.',
  cancel: 'Batal',
  roleViewer: 'viewer',
  roleOperator: 'operator',
  roleApprover: 'approver',
  roleOwner: 'owner',
  errNetwork: 'Tidak bisa menghubungi server.',
  errAuth: 'Tidak diizinkan. Muat ulang halaman dan masuk lagi.',
  errGeneric: 'Permintaan gagal. Coba lagi.',
  errGroupRole: 'Chat grup hanya boleh role viewer atau operator.',
  errInvalid: 'Input ditolak server.',
  errGone: 'Data sudah tidak ada.',
} as const

/** Waktu relatif ringkas dari epoch ms; `now` disuntik supaya bisa dites. */
export function relativeTime(at: number, now: number): string {
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 5) return 'baru saja'
  if (sec < 60) return `${sec} dtk lalu`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} mnt lalu`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} jam lalu`
  return `${Math.floor(hour / 24)} hari lalu`
}
