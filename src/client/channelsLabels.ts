// Seluruh string UI section Channels (Rule 15): satu tempat, tidak ada literal di komponen.
export const CH = {
  title: 'Channels',
  loading: 'Memuat status channel…',
  refresh: 'Segarkan',
  refreshing: 'Menyegarkan…',
  inactiveTitle: 'Channel Telegram nonaktif',
  inactiveHint:
    'Aktifkan dengan mengisi WEBTERM_TELEGRAM=on dan WEBTERM_TELEGRAM_BOT_TOKEN (alias lama: TELEGRAM_BOT_TOKEN). Atur di Settings > Fitur & server (sementara) lalu restart.',
  statusHeading: 'Status',
  mode: 'Mode',
  modePoll: 'poll (long polling)',
  modeWebhook: 'webhook',
  botToken: 'Bot token',
  webhookSecret: 'Webhook secret',
  set: 'Terpasang',
  unset: 'Belum dipasang',
  ingress: 'Ingress (pesan masuk)',
  egress: 'Egress (pesan keluar)',
  lastOk: 'terakhir OK',
  never: 'belum pernah',
  okCount: 'OK',
  errorCount: 'error',
  lastError: 'error terakhir',
  pendingHeading: 'Menunggu bind',
  pendingEmpty: 'Tidak ada chat yang menunggu. Kirim pesan ke bot untuk melihatnya di sini.',
  pendingHint: 'Chat yang menghubungi bot tapi belum ter-bind. Bot tidak membalas chat ini sampai di-bind.',
  messages: 'pesan',
  lastSeen: 'terakhir terlihat',
  role: 'Role',
  projectId: 'Project ID',
  projectIdPlaceholder: 'project id',
  projectIdInvalid: 'Project ID wajib diisi, maksimal 200 karakter, tanpa karakter kontrol.',
  bind: 'Bind',
  ignore: 'Abaikan',
  bindingsHeading: 'Binding aktif',
  bindingsEmpty: 'Belum ada chat yang ter-bind.',
  remove: 'Hapus',
  removeTitle: 'Hapus binding?',
  removeDescription: 'Chat ini tidak akan bisa lagi memakai bot sampai di-bind ulang.',
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
