// Seluruh teks kartu Telegram (Rule 15): satu tempat, komponen tanpa literal UI.
export const TG = {
  title: 'Telegram',
  intro: 'Create a bot with @BotFather, then paste its token here.',
  tokenLabel: 'Bot token',
  connect: 'Connect',
  connecting: 'Checking token...',
  connected: (bot: string): string => `Connected as ${bot}`,
  connectedAnon: 'Connected',
  stopBot: 'Stop bot',
  restart: 'Start again',
  restartHint: 'The bot is stopped. The previous token is still saved.',
  orNewToken: 'Or connect a different bot:',
  errRestart: 'The saved token can’t be used. Paste the bot token again.',
  unlink: 'Unlink',
  pairIntro: (project: string): string =>
    `Link a Telegram chat to project ${project}: open this link and press Start. Single use, valid for 10 minutes.`,
  pairOpen: 'Open in Telegram',
  pairLinkLabel: 'Pairing link',
  pairQrLabel: 'QR code of the pairing link. Scan it with your phone camera.',
  forwardLabel: 'Send agent updates to Telegram after minutes away (0 = off)',
  forwardHint: 'When every webterm tab has been hidden this long, finished agents and agents that need input are reported to linked chats. Muted workspaces stay silent.',
  copy: 'Copy',
  copied: 'Copied',
  noProject: 'Open a workspace first to link a chat to its project.',
  token_rejected: 'Telegram rejected the token. Copy it again from @BotFather.',
  unreachable: 'Can’t reach Telegram. Check your internet connection and try again.',
  invalid_token_shape: 'Token format not recognized. Copy the whole token from @BotFather.',
  errGeneric: 'Could not connect Telegram. Try again.',
  errAction: 'Action failed. Try again.',
  stopping: 'Stopping…', stopped: 'Bot stopped.', starting: 'Starting…', started: 'Bot started.',
  linking: 'Linking…', linked: 'Chat linked.', ignoring: 'Ignoring…', ignored: 'Chat ignored.',
  unlinking: 'Unlinking…', unlinked: 'Chat unlinked.',
  pendingAsk: (who: string, project: string): string => `${who} messaged the bot. Link to project ${project}?`,
  link: 'Link',
  ignore: 'Ignore',
  linkedHeading: 'Linked chats',
  chatName: (chatId: string): string => `Chat ${chatId}`,
  linkedRow: (chat: string, project: string): string => `${chat} · project ${project}`,
} as const

/** Kode galat server -> teks; kode asing jatuh ke pesan umum. */
export function connectErrorText(code: string): string {
  if (code === 'token_rejected' || code === 'unreachable' || code === 'invalid_token_shape') return TG[code]
  return TG.errGeneric
}
