// Teks galat klien API channel (Rule 15). Section Channels sudah dihapus (ENVSIMPLE D6); sisa ini
// hanya dipakai `channelsApi.ts` (kartu Telegram) untuk memetakan galat ke kalimat Indonesia.
export const CH = {
  projectIdInvalid: 'Project ID is required, at most 200 characters, with no control characters.',
  errNetwork: 'Can’t reach the server.',
  errAuth: 'Not allowed. Reload the page and sign in again.',
  errGeneric: 'Request failed. Try again.',
  errGroupRole: 'Group chats can only have the viewer or operator role.',
  errInvalid: 'The server rejected the input.',
  errGone: 'The data no longer exists.',
} as const
