// Docs for the env-only bootstrap keys (BOOTSTRAP_ONLY_KEYS has names only). Read by `webterm --help`
// and `--docs env`; envRegistry.bootstrap.test.ts fails when a bootstrap key has no entry here.
import { DEFAULT_HOST } from './auth'
import { DEFAULT_TELEGRAM_API_BASE } from './channels/telegram'
import { DEFAULT_PORT } from './serverConfig'

export interface BootstrapEnvDoc {
  description: string
  default?: string
}

/** One-line description + default for every key in BOOTSTRAP_ONLY_KEYS. */
export const BOOTSTRAP_ENV_DOCS: Readonly<Record<string, BootstrapEnvDoc>> = {
  HOST: { description: 'Bind address.', default: DEFAULT_HOST },
  PORT: { description: 'Listen port; a bad value aborts startup.', default: String(DEFAULT_PORT) },
  WEBTERM_HOST: { description: 'Fallback for HOST.' },
  WEBTERM_PROXY_PORT: { description: 'Port of the separate-origin dev-server proxy (/proxy/<port>).', default: 'PORT+1' },
  WEBTERM_DATA_DIR: { description: 'Data directory (SQLite store webterm.db, secrets, logs).', default: '~/.webterm-server' },
  WEBTERM_TOKEN: { description: 'Root access token; without it, read or generated in <data dir>/secrets/WEBTERM_TOKEN.' },
  WEBTERM_ALLOW_TOKEN_MINT: { description: 'Set 1 to enable the root-only capability token mint route.', default: '0' },
  WEBTERM_STRICT_HOOK_AUTH: { description: 'Set 0 to accept agent status hooks without a node token.', default: '1' },
  WEBTERM_TELEGRAM_API_BASE: { description: 'Telegram Bot API base URL.', default: DEFAULT_TELEGRAM_API_BASE },
  WEBTERM_ENV_SETTINGS: { description: 'Set off to lock Settings so env overrides cannot be changed from the UI.', default: 'on' },
}
