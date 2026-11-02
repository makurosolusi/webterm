// Registry env: ledger + kanal Telegram. Data murni (lihat envRegistry.types.ts).
import { MAX_WEBHOOK_SECRET_CHARS, MIN_WEBHOOK_SECRET_CHARS } from './channels/channelSecret'
import { enumOf, flag, secret, type EnvSpec } from './envRegistry.types'

/** Bentuk token bot Telegram: `<id>:<hash>`, tanpa spasi. */
const BOT_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{10,}$/
const WEBHOOK_SECRET_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${MIN_WEBHOOK_SECRET_CHARS},${MAX_WEBHOOK_SECRET_CHARS}}$`)

export const CHANNEL_ENV_SPECS: readonly EnvSpec[] = [
  enumOf('WEBTERM_LEDGER', 'ledger', ['off', 'shadow', 'on'], 'off', {
    label: 'Ledger',
    description: 'Mode ledger proyek/task. `on` menolak boot bila ledger rusak.',
  }),
  enumOf('WEBTERM_CHANNELS', 'channels', ['on', 'off'], 'on', {
    label: 'Kanal (saklar utama)',
    description: '`off` mematikan seluruh runtime kanal walau Telegram aktif.',
  }),
  flag('WEBTERM_TELEGRAM', 'telegram', { label: 'Telegram', description: 'Aktifkan kanal Telegram (butuh ledger hidup).' }),
  enumOf('WEBTERM_TELEGRAM_MODE', 'telegram', ['poll', 'webhook'], 'poll', {
    label: 'Mode masuk Telegram',
    description: 'poll = getUpdates, webhook = terima POST. Kosong + tanpa token bot berarti webhook.',
  }),
  secret('WEBTERM_TELEGRAM_BOT_TOKEN', 'telegram', BOT_TOKEN_SHAPE, {
    label: 'Token bot Telegram',
    description: 'Write-only; tidak pernah ditampilkan kembali.',
  }),
  secret('WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'telegram', WEBHOOK_SECRET_SHAPE, {
    label: 'Secret webhook Telegram',
    description: `Write-only; ${MIN_WEBHOOK_SECRET_CHARS}-${MAX_WEBHOOK_SECRET_CHARS} karakter [A-Za-z0-9_-].`,
  }),
]
