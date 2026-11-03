// Gerbang induk kanal: kanal ada bila kemampuan `telegram` on. Satu-satunya pembaca kunci adalah
// isEnabled (pagar grep ES-14); tak ada saklar kanal terpisah yang bisa menyimpang dari Telegram.
import { isEnabled } from '../featureCapabilities.runtime'

export type ChannelsMasterState = 'on' | 'off'

/** `on` bila kemampuan telegram on (termasuk prasyaratnya), selain itu `off`. */
export function channelsMasterState(env: NodeJS.ProcessEnv = process.env): ChannelsMasterState {
  return isEnabled('telegram', env) ? 'on' : 'off'
}
