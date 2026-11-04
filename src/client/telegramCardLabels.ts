// Seluruh teks kartu Telegram (Rule 15): satu tempat, komponen tanpa literal UI.
export const TG = {
  title: 'Telegram',
  intro: 'Buat bot lewat @BotFather lalu tempel tokennya di sini.',
  tokenLabel: 'Token bot',
  connect: 'Hubungkan',
  connecting: 'Memeriksa token...',
  connected: (bot: string): string => `Tersambung sebagai ${bot}`,
  connectedAnon: 'Tersambung',
  stopBot: 'Matikan bot',
  restart: 'Nyalakan lagi',
  restartHint: 'Bot sedang mati. Token lama masih tersimpan.',
  orNewToken: 'Atau hubungkan bot lain:',
  errRestart: 'Token tersimpan tidak bisa dipakai. Tempel token bot lagi.',
  unlink: 'Lepas tautan',
  pairIntro: (project: string): string =>
    `Tautkan chat Telegram ke proyek ${project}: buka tautan ini lalu tekan Start. Sekali pakai, berlaku 10 menit.`,
  pairOpen: 'Buka di Telegram',
  pairLinkLabel: 'Tautan pairing',
  copy: 'Salin',
  copied: 'Tersalin',
  noProject: 'Buka sebuah workspace dulu untuk menautkan chat ke proyeknya.',
  token_rejected: 'Token ditolak Telegram. Salin ulang dari @BotFather.',
  unreachable: 'Tidak bisa menjangkau Telegram. Periksa koneksi internet lalu coba lagi.',
  invalid_token_shape: 'Bentuk token tidak dikenali. Salin lengkap dari @BotFather.',
  errGeneric: 'Gagal menghubungkan Telegram. Coba lagi.',
  errAction: 'Aksi gagal. Coba lagi.',
  pendingAsk: (who: string, project: string): string => `${who} mengirim pesan ke bot. Tautkan ke proyek ${project}?`,
  link: 'Tautkan',
  ignore: 'Abaikan',
  linkedHeading: 'Chat tertaut',
  chatName: (chatId: string): string => `Chat ${chatId}`,
  linkedRow: (chat: string, project: string): string => `${chat} · proyek ${project}`,
} as const

/** Kode galat server -> teks; kode asing jatuh ke pesan umum. */
export function connectErrorText(code: string): string {
  if (code === 'token_rejected' || code === 'unreachable' || code === 'invalid_token_shape') return TG[code]
  return TG.errGeneric
}
