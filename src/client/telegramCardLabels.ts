// Seluruh teks kartu Telegram (Rule 15): satu tempat, komponen tanpa literal UI.
export const TG = {
  title: 'Telegram',
  intro: 'Buat bot lewat @BotFather lalu tempel tokennya di sini.',
  tokenLabel: 'Token bot',
  connect: 'Hubungkan',
  connecting: 'Memeriksa token...',
  connected: (bot: string): string => `Tersambung sebagai ${bot}`,
  connectedAnon: 'Tersambung',
  disconnect: 'Putuskan',
  token_rejected: 'Token ditolak Telegram. Salin ulang dari @BotFather.',
  unreachable: 'Tidak bisa menjangkau Telegram. Periksa koneksi internet lalu coba lagi.',
  invalid_token_shape: 'Bentuk token tidak dikenali. Salin lengkap dari @BotFather.',
  errGeneric: 'Gagal menghubungkan Telegram. Coba lagi.',
  errAction: 'Aksi gagal. Coba lagi.',
  pendingAsk: (who: string): string => `${who} mengirim pesan ke bot. Tautkan chat ini?`,
  link: 'Tautkan',
  ignore: 'Abaikan',
  linkedHeading: 'Chat tertaut',
  chatName: (chatId: string): string => `Chat ${chatId}`,
} as const

/** Kode galat server -> teks; kode asing jatuh ke pesan umum. */
export function connectErrorText(code: string): string {
  if (code === 'token_rejected' || code === 'unreachable' || code === 'invalid_token_shape') return TG[code]
  return TG.errGeneric
}
