// The master kill switch that sits above every provider flag (`WEBTERM_TELEGRAM`, later adapters).
// Keeping it separate from the HTTP edge means one obvious place decides whether the channel
// runtime exists at all, and the runtime module stays under its size budget.
export const CHANNELS_MASTER_ENV = 'WEBTERM_CHANNELS'

/** The only values this iteration implements; `readonly|control` remain planned. */
export const CHANNELS_MASTER_VALUES = 'on|off' as const

export type ChannelsMasterState = 'on' | 'off' | 'unsupported'

/**
 * Unset and `on` both preserve the pre-gate behavior; `off` disables the whole runtime. Any other
 * value (including the planned `readonly`/`control`) fails closed as `unsupported`: taking the
 * channel down is recoverable, silently accepting an unknown mode is not. The caller owns the log
 * line so it can name the supported values exactly once.
 */
export function channelsMasterState(env: NodeJS.ProcessEnv = process.env): ChannelsMasterState {
  const raw = (env[CHANNELS_MASTER_ENV] ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'on') return 'on'
  if (raw === 'off') return 'off'
  return 'unsupported'
}
