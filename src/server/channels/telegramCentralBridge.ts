import type { Database } from 'bun:sqlite'
import { flagOn } from '../envFlag'
import { resolveChatService } from '../centralChatHandlers'
import { listMessages, type TurnService } from '../central/chat/turnService'
import { CentralChatError } from '../central/chat/chatErrors'
import { ConversationError, PROJECT_CONVERSATION_PREFIX } from '../central/conversationModel'
import { getTurn } from '../central/conversationStore'
import type { RuntimeKind } from '../central/runtime/centralRuntime'
import type { TelegramCentralPort } from './channelDispatch'

const TIMEOUT_MS = 120_000
// Persisted turn error code (RuntimeErrorCode) that maps to a fast, distinct Telegram reply.
const RUNTIME_UNAVAILABLE = 'runtime_unavailable'

// D-phase gate, independent of WEBTERM_CENTRAL_CHAT.
export function centralTelegramEnabled(raw = process.env.WEBTERM_CENTRAL_TELEGRAM): boolean {
  return flagOn(raw)
}

export function createTelegramCentralPort(input: {
  db: Database
  kind: RuntimeKind
  now?: () => number
  service?: TurnService
}): TelegramCentralPort {
  const chat = resolveChatService({ now: input.now, service: input.service }, input.db, input.kind)
  return {
    async ask({ projectId, text, updateId }) {
      const conversationId = `${PROJECT_CONVERSATION_PREFIX}${projectId}`
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const submitted = chat.service.submit({ conversationId, clientMessageId: `telegram:${updateId}`, text })
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('central_timeout')), TIMEOUT_MS)
        })
        await Promise.race([submitted.done, timeout])
        // Claude missing / logged out fails the turn at once; say so instead of a generic "empty".
        if (getTurn(input.db, submitted.response.turnId)?.errorCode === RUNTIME_UNAVAILABLE) {
          return { ok: false, code: 'central_runtime_unavailable' }
        }
        const page = listMessages(input.db, conversationId, { limit: 20 })
        const assistant = page.items.find(
          (message) => message.role === 'assistant' && message.turnId === submitted.response.turnId
        ) ?? page.items.filter((message) => message.role === 'assistant').at(-1)
        const answer = assistant?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? ''
        return answer ? { ok: true, text: answer } : { ok: false, code: 'central_empty' }
      } catch (error) {
        if (error instanceof CentralChatError || error instanceof ConversationError) return { ok: false, code: error.code }
        if (error instanceof Error && error.message === 'central_timeout') return { ok: false, code: 'central_timeout' }
        return { ok: false, code: input.kind === 'off' ? 'central_runtime_off' : 'central_runtime_error' }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
