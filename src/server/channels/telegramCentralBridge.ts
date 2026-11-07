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
}): TelegramCentralPort {
  const chat = resolveChatService({ now: input.now, service: input.service }, input.db, input.kind)
  return {
    async ask({ projectId, text, updateId }) {
      const conversationId = GLOBAL_CONVERSATION_ID
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const contextual = `[via Telegram, project: ${projectLabel(input.db, projectId)}]\n${text}`
        const submitted = chat.service.submit({ conversationId, clientMessageId: `telegram:${updateId}`, text: contextual })
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
        if (error instanceof CentralChatError || error instanceof ConversationError) return { ok: false, code: error.code }
        if (error instanceof Error && error.message === 'central_timeout') return { ok: false, code: 'central_timeout' }
        return { ok: false, code: input.kind === 'off' ? 'central_runtime_off' : 'central_runtime_error' }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
