// Ingress side of deep-link pairing: `/start <code>` from a private chat redeems a one-time code
// (telegramPairing.ts) and binds that chat to the code's project, then confirms in the chat.
import type { DispatchOutcome, TelegramDispatchDeps } from './channelDispatch'
import type { NormalizedMessage } from './telegram'
import { startCodeOf } from './telegramPairing'
import { safeErrorText } from './safeErrorText'
import { createLogger } from '../logs'

const log = createLogger('channels.telegram')
const TELEGRAM_CHANNEL = 'telegram'

/** Null = not a live pairing code; the caller continues its usual (silent-for-strangers) path. */
export async function pairFromStart(
  deps: TelegramDispatchDeps,
  message: NormalizedMessage,
  reply: (text: string) => Promise<string | null>
): Promise<DispatchOutcome | null> {
  const code = startCodeOf(message.text)
  const { pending, store } = deps
  if (code === null || !pending?.redeem || !store.bind) return null
  const grant = pending.redeem(code)
  if (grant === null) return null
  let text: string
  try {
    // Private chat only (groups are denied before this); owner role, like the card's manual link.
    store.bind(TELEGRAM_CHANNEL, message.chatId, { projectId: grant.projectId, role: 'owner', userId: message.userId })
    pending.remove?.(message.chatId)
    text = `Linked to webterm project "${grant.projectName}". Send /status or /inbox to start.`
  } catch (err) {
    log.warn('channel.dispatch', `telegram pairing bind failed: ${safeErrorText(err, 'store unavailable')}`, { stage: 'pair' })
    text = 'Could not link this chat. Open a new link from webterm Settings and try again.'
  }
  deps.audit?.({ kind: 'channel.telegram.command', outcome: 'handled', updateId: message.updateId, command: 'pair', projectId: grant.projectId })
  return { status: 'handled', command: 'pair', reply: await reply(text) }
}
