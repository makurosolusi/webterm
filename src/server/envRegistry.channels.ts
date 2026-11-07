// Registry env: ledger + kanal Telegram (owner channels). Data murni (lihat envRegistry.types.ts).
import { MAX_WEBHOOK_SECRET_CHARS, MIN_WEBHOOK_SECRET_CHARS } from './channels/channelSecret'
import { enumOf, flag, secret, type EnvSpec } from './envRegistry.types'

/** Bentuk token bot Telegram: `<id>:<hash>`, tanpa spasi. */
export const BOT_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{10,}$/
const WEBHOOK_SECRET_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${MIN_WEBHOOK_SECRET_CHARS},${MAX_WEBHOOK_SECRET_CHARS}}$`)
const TG = { owner: 'channels', section: 'Telegram' } as const
const ON_OFF = { on: 'On', off: 'Off' }
const LEDGER = 'WEBTERM_LEDGER'
const TELEGRAM = 'WEBTERM_TELEGRAM'
const TELEGRAM_ON = { key: TELEGRAM }

export const CHANNEL_ENV_SPECS: readonly EnvSpec[] = [
  enumOf(LEDGER, 'ledger', ['off', 'shadow', 'on'], 'off', {
    owner: 'platform', section: 'Basics', audience: 'user', restart: 'boot',
    label: 'Ledger',
    description: 'Record of projects, tasks, and approvals. Shadow records without blocking; On refuses to boot if the ledger is corrupt.',
    optionLabels: { off: 'Off', shadow: 'Shadow', on: 'On' },
  }),
  enumOf('WEBTERM_CHANNELS', 'channels', ['on', 'off'], 'on', {
    ...TG, audience: 'user', restart: 'hot',
    label: 'Channels (main switch)',
    description: 'Off stops the whole channel runtime even if Telegram is on.',
    optionLabels: ON_OFF,
  }),
  flag(TELEGRAM, 'telegram', {
    ...TG, audience: 'user', restart: 'hot',
    label: 'Telegram',
    description: 'Enables the Telegram channel (needs channels on). Applies immediately without a restart.',
    requires: [{ key: 'WEBTERM_CHANNELS', oneOf: ['on'], note: 'The channels switch is off.' }],
  }),
  enumOf('WEBTERM_TELEGRAM_MODE', 'telegram', ['', 'poll', 'webhook'], '', {
    ...TG, audience: 'user', restart: 'boot', allowEmpty: true,
    label: 'Telegram inbound mode',
    description: 'Polling pulls messages through getUpdates; webhook receives POSTs from Telegram. Automatic = poll when a bot token exists, otherwise webhook.',
    effectiveDefault: 'automatic: poll when a token exists, otherwise webhook',
    optionLabels: { '': 'Automatic', poll: 'Polling (getUpdates)', webhook: 'Webhook' },
    requires: [TELEGRAM_ON],
  }),
  secret('WEBTERM_TELEGRAM_BOT_TOKEN', 'telegram', BOT_TOKEN_SHAPE, {
    ...TG, audience: 'user', restart: 'hot',
    label: 'Telegram bot token',
    description: 'Write-only, never shown again. Applies immediately without a restart, for both sending and receiving.',
    requires: [TELEGRAM_ON],
  }),
  secret('WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'telegram', WEBHOOK_SECRET_SHAPE, {
    ...TG, audience: 'advanced', restart: 'boot',
    label: 'Telegram webhook secret',
    description: `Write-only; ${MIN_WEBHOOK_SECRET_CHARS}-${MAX_WEBHOOK_SECRET_CHARS} characters [A-Za-z0-9_-]. Webhook mode only. Alternative: env WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE pointing to a secret file.`,
    requires: [TELEGRAM_ON, { key: 'WEBTERM_TELEGRAM_MODE', oneOf: ['webhook', ''], note: 'Webhook mode only (or automatic).' }],
  }),
  flag('WEBTERM_CENTRAL_TELEGRAM', 'telegram', {
    ...TG, audience: 'user', hot: true,
    label: 'Central via Telegram',
    description: 'Bridges central chat to Telegram (needs Central, Central chat, and a central runtime).',
    requires: [
      TELEGRAM_ON, { key: 'WEBTERM_CENTRAL' }, { key: 'WEBTERM_CENTRAL_CHAT' },
      { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['claude', 'mock', ''], note: 'The central runtime is still off (empty = auto-detect).' },
    ],
  }),
]
