// Registry env: ledger + kanal Telegram (owner channels). Data murni (lihat envRegistry.types.ts).
import { MAX_WEBHOOK_SECRET_CHARS, MIN_WEBHOOK_SECRET_CHARS } from './channels/channelSecret'
import { enumOf, flag, secret, type EnvSpec } from './envRegistry.types'

/** Bentuk token bot Telegram: `<id>:<hash>`, tanpa spasi. */
const BOT_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{10,}$/
const WEBHOOK_SECRET_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${MIN_WEBHOOK_SECRET_CHARS},${MAX_WEBHOOK_SECRET_CHARS}}$`)
const TG = { owner: 'channels', section: 'Telegram' } as const
const ON_OFF = { on: 'Aktif', off: 'Mati' }
const LEDGER = 'WEBTERM_LEDGER'
const TELEGRAM = 'WEBTERM_TELEGRAM'
const LEDGER_READY = { key: LEDGER, oneOf: ['on', 'shadow'], note: 'Telegram butuh ledger hidup.' }
const TELEGRAM_ON = { key: TELEGRAM }

export const CHANNEL_ENV_SPECS: readonly EnvSpec[] = [
  enumOf(LEDGER, 'ledger', ['off', 'shadow', 'on'], 'off', {
    owner: 'platform', section: 'Dasar', audience: 'user', restart: 'boot',
    label: 'Ledger',
    description: 'Catatan proyek, task, dan approval. Bayangan mencatat tanpa memblokir; Aktif menolak boot bila ledger rusak.',
    optionLabels: { off: 'Mati', shadow: 'Bayangan', on: 'Aktif' },
  }),
  enumOf('WEBTERM_CHANNELS', 'channels', ['on', 'off'], 'on', {
    ...TG, audience: 'user', restart: 'boot',
    label: 'Kanal (saklar utama)',
    description: 'Mati menghentikan seluruh runtime kanal walau Telegram aktif.',
    optionLabels: ON_OFF,
  }),
  flag(TELEGRAM, 'telegram', {
    ...TG, audience: 'user', restart: 'boot',
    label: 'Telegram',
    description: 'Aktifkan kanal Telegram (butuh ledger hidup dan kanal aktif).',
    requires: [LEDGER_READY, { key: 'WEBTERM_CHANNELS', oneOf: ['on'], note: 'Saklar kanal sedang mati.' }],
  }),
  enumOf('WEBTERM_TELEGRAM_MODE', 'telegram', ['poll', 'webhook'], '', {
    ...TG, audience: 'user', restart: 'boot', allowEmpty: true,
    label: 'Mode masuk Telegram',
    description: 'Polling menarik pesan lewat getUpdates; webhook menerima POST dari Telegram. Kosong = otomatis.',
    effectiveDefault: 'otomatis: poll bila token ada, selain itu webhook',
    optionLabels: { poll: 'Polling (getUpdates)', webhook: 'Webhook' },
    requires: [TELEGRAM_ON],
  }),
  secret('WEBTERM_TELEGRAM_BOT_TOKEN', 'telegram', BOT_TOKEN_SHAPE, {
    ...TG, audience: 'user', restart: 'hot',
    label: 'Token bot Telegram',
    description: 'Write-only, tidak pernah ditampilkan lagi. Pengiriman langsung berlaku; penerimaan (polling) setelah restart.',
    requires: [TELEGRAM_ON],
  }),
  secret('WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'telegram', WEBHOOK_SECRET_SHAPE, {
    ...TG, audience: 'advanced', restart: 'boot',
    label: 'Secret webhook Telegram',
    description: `Write-only; ${MIN_WEBHOOK_SECRET_CHARS}-${MAX_WEBHOOK_SECRET_CHARS} karakter [A-Za-z0-9_-]. Hanya dipakai mode webhook.`,
    requires: [TELEGRAM_ON, { key: 'WEBTERM_TELEGRAM_MODE', oneOf: ['webhook', ''], note: 'Hanya mode webhook (atau otomatis).' }],
  }),
  flag('WEBTERM_CENTRAL_TELEGRAM', 'telegram', {
    ...TG, audience: 'user', restart: 'boot',
    label: 'Central via Telegram',
    description: 'Jembatan chat central ke Telegram (butuh Central, Central chat, runtime central, ledger hidup).',
    requires: [
      TELEGRAM_ON, { key: 'WEBTERM_CENTRAL' }, { key: 'WEBTERM_CENTRAL_CHAT' },
      { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['mock', 'opencode'], note: 'Runtime central masih mati.' }, LEDGER_READY,
    ],
  }),
]
