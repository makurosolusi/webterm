import type { Database } from 'bun:sqlite'
import { isEnabled } from '../featureCapabilities.runtime'
import { resolveChatService } from '../centralChatHandlers'
import { listMessages, type TurnService } from '../central/chat/turnService'
import { CentralChatError } from '../central/chat/chatErrors'
import { ConversationError, GLOBAL_CONVERSATION_ID } from '../central/conversationModel'
import { getTurn } from '../central/conversationStore'
import { getRow } from '../ledger/ledgerCore'
import { lookupWorkspace } from '../central/workspaceLookup'
import type { RuntimeKind } from '../central/runtime/centralRuntime'
import type { TelegramCentralPort } from './channelDispatch'

const TIMEOUT_MS = 120_000
/** Telegram messages that may wait behind a running turn; one more is refused (`central_queue_full`). */
export const TELEGRAM_QUEUE_MAX = 5
/** How long a queued message waits for the conversation before giving up (`central_queue_timeout`). */
const QUEUE_WAIT_MS = 10 * 60_000
const QUEUE_POLL_MS = 500

/** A Telegram message the queue could not take or could not run; `code` is the reply code. */
class TelegramQueueError extends Error {
  constructor(readonly code: 'central_queue_full' | 'central_queue_timeout', message: string) {
    super(`${code}: ${message}`)
  }
}
// Persisted turn error code (RuntimeErrorCode) that maps to a fast, distinct Telegram reply.
const RUNTIME_UNAVAILABLE = 'runtime_unavailable'

// Gerbang jembatan: butuh kemampuan central DAN telegram (bukan lagi saklar tersendiri).
export function centralTelegramEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled('central', env) && isEnabled('telegram', env)
}

/**
 * Name of the chat's bound project for the context line: the workspace (bindings carry workspace
 * ids), else the ledger project by id or workspace id, else the raw id.
 */
function projectLabel(db: Database, id: string): string {
  const workspace = lookupWorkspace(id)?.name
  if (workspace) return workspace
  const row = getRow(db, 'SELECT name FROM project WHERE id = ? OR workspace_id = ? LIMIT 1', id, id)
  return typeof row?.['name'] === 'string' ? row['name'] : id
}

/**
 * Telegram is a remote door into the SAME conversation the Central UI opens by default
 * (`central:global`): same history, approvals and notices. The bound project rides along as a
 * context line instead of a separate per-project conversation.
 */
export function createTelegramCentralPort(input: {
  db: Database
  kind: RuntimeKind
  now?: () => number
  service?: TurnService
  /** Test seam: how often a queued message re-checks the conversation. */
  pollMs?: number
}): TelegramCentralPort {
  const chat = resolveChatService({ now: input.now, service: input.service }, input.db, input.kind)
  const conversationId = GLOBAL_CONVERSATION_ID
  // FIFO of update ids waiting for `central:global` (one conversation, so one queue). The turn
  // service has no queue of its own: a submit while a turn runs throws `conversation_busy`.
  const queue: number[] = []
  const isBusy = (error: unknown): boolean => error instanceof CentralChatError && error.code === 'conversation_busy'
  /** Submits now, or waits its turn in the FIFO and submits as the next turn. */
  async function submitQueued(updateId: number, text: string, onQueued?: () => void): Promise<ReturnType<TurnService['submit']>> {
    const submit = () => chat.service.submit({ conversationId, clientMessageId: `telegram:${updateId}`, text })
    if (queue.length === 0) {
      try { return submit() } catch (error) { if (!isBusy(error)) throw error }
    }
    if (queue.length >= TELEGRAM_QUEUE_MAX) throw new TelegramQueueError('central_queue_full', `${TELEGRAM_QUEUE_MAX} Telegram messages are already waiting`)
    queue.push(updateId)
    onQueued?.()
    const deadline = Date.now() + QUEUE_WAIT_MS
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? QUEUE_POLL_MS))
        if (queue[0] !== updateId) continue
        try { return submit() } catch (error) { if (!isBusy(error)) throw error }
        if (Date.now() > deadline) throw new TelegramQueueError('central_queue_timeout', 'the Central conversation stayed busy')
      }
    } finally {
      queue.splice(queue.indexOf(updateId), 1)
    }
  }
  return {
    async ask({ projectId, text, updateId, onQueued }) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const contextual = `[via Telegram, project: ${projectLabel(input.db, projectId)}]\n${text}`
        const submitted = await submitQueued(updateId, contextual, onQueued)
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('central_timeout')), TIMEOUT_MS)
        })
        await Promise.race([submitted.done, timeout])
        // Claude missing / logged out fails the turn at once; say so instead of a generic "empty".
        const turn = getTurn(input.db, submitted.response.turnId)
        if (turn?.errorCode === RUNTIME_UNAVAILABLE) {
          return { ok: false, code: 'central_runtime_unavailable' }
        }
        const page = listMessages(input.db, conversationId, { limit: 20 })
        const assistant = page.items.find(
          (message) => message.role === 'assistant' && message.turnId === submitted.response.turnId
        ) ?? page.items.filter((message) => message.role === 'assistant').at(-1)
        const answer = assistant?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? ''
        return answer ? { ok: true, text: answer } : { ok: false, code: 'central_empty' }
      } catch (error) {
        if (error instanceof CentralChatError || error instanceof ConversationError || error instanceof TelegramQueueError) return { ok: false, code: error.code }
        if (error instanceof Error && error.message === 'central_timeout') return { ok: false, code: 'central_timeout' }
        return { ok: false, code: input.kind === 'off' ? 'central_runtime_off' : 'central_runtime_error' }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
