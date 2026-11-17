// Wiring of the Agent Chat controls around one view: the composer's "/" and "@" completion, the
// composer row (model / effort) and header history, the commands the chat answers itself (`/model`, `/resume`,
// `/clear`), and what the node persists (session id, model / effort / thinking).
//
// Config persistence: the server keeps model / effort / thinking in memory only, so the node is the
// record. Every `config` event is saved into the node; on every stream open (mount, reconnect, server
// restart) a stored config that differs from what the server knows is sent back with setConfig. While
// that sync runs, config events are not saved: the replayed (older) one must not overwrite the record.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentChatConfig, AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentChatNodeConfig } from '../../shared/agentChat.shape'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { ChatStreamStatus } from '../chat/chatTypes'
import { chatErrorMessage } from '../chat/chatTransport'
import { search } from '../fsClient'
import type { AgentChatToolbarProps } from './agentChatToolbar'
import { interceptOf, LOCAL_COMMANDS } from './agentChatIntercept'
import type { AgentChatState } from './agentChatStore'
import { AgentChatApiError, type AgentChatTransport } from './agentChatTransport'
import { agentChatCompletion, type ComposerCompletion, type FileEntry } from './composerCompletion'

/** Matches every file of the folder (Quick Open's query); `@` ranks the list itself. */
const ALL_FILES = '*'

export type AgentChatPatch = { chatSessionId?: string; permissionMode?: AgentPermissionMode; chatConfig?: AgentChatNodeConfig }

/** User text of a failed request (agent chat errors carry their own; anything else gets the shared text). */
export const why = (err: unknown): string => (err instanceof AgentChatApiError ? err.message : chatErrorMessage(err))

/** The node's record of a server config. */
export const nodeConfigOf = (c: AgentChatConfig): AgentChatNodeConfig =>
  ({ ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), thinking: c.thinking })

/** Does the server config already match every field the node stored? */
export function sameConfig(stored: AgentChatNodeConfig, server: AgentChatConfig | undefined): boolean {
  if (!server) return Object.keys(stored).length === 0
  return (stored.model === undefined || stored.model === server.model)
    && (stored.effort === undefined || stored.effort === server.effort)
    && (stored.thinking === undefined || stored.thinking === server.thinking)
}

export interface AgentChatControlsInput {
  transport: AgentChatTransport
  state: AgentChatState
  stream: ChatStreamStatus
  /** The node's folder until `init` reports the resolved one. */
  cwd?: string
  /** What the node stored (its data); written back through `onNodeData`. */
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
  chatConfig?: AgentChatNodeConfig
  onNodeData: (patch: AgentChatPatch) => void
}

export function useAgentChatControls(input: AgentChatControlsInput) {
  const { transport, state, stream, cwd, chatConfig, onNodeData } = input
  const [error, setError] = useState<string | null>(null)
  const [openPicker, setOpenPicker] = useState<AgentChatToolbarProps['openPicker']>()
  const [syncing, setSyncing] = useState(false)
  const stored = useRef(chatConfig)
  stored.current = chatConfig
  const known = useRef(state.config)
  known.current = state.config

  const root = state.session?.cwd || cwd
  const completion: ComposerCompletion = useMemo(() => {
    // One listing per `@` token (a bare `@` refetches), ranked locally while the query grows.
    let files: Promise<FileEntry[]> | null = null
    const searchFiles = (query: string): Promise<FileEntry[]> => {
      if (!root) return Promise.reject(new Error('The folder of this chat is not known yet.'))
      if (!files || query === '') {
        files = search(root, ALL_FILES).then((r) => {
          if (!r.ok) throw new Error(r.error)
          return r.files.map((path) => ({ path, dir: false }))
        })
        files.catch(() => { files = null })
      }
      return files
    }
    return agentChatCompletion({ loadCommands: () => transport.catalog(), searchFiles, localCommands: LOCAL_COMMANDS })
    // catalogVersion: a `commandsChanged` event drops the cached catalog by building a new completion.
  }, [transport, root, state.catalogVersion])

  // Restore the stored config on every open of the stream.
  useEffect(() => {
    const want = stored.current
    if (stream !== 'open' || !want || sameConfig(want, known.current)) return
    setSyncing(true)
    transport.setConfig(want).then(
      () => setSyncing(false),
      (err: unknown) => { setSyncing(false); setError(`Could not restore this chat's model settings: ${why(err)}`) },
    )
  }, [stream, transport])

  const config = state.config
  useEffect(() => {
    if (syncing || !config) return
    const next = nodeConfigOf(config)
    const cur = stored.current
    if (!cur || cur.model !== next.model || cur.effort !== next.effort || cur.thinking !== next.thinking) onNodeData({ chatConfig: next })
  }, [config, syncing, onNodeData])

  // Session id and mode, as the server reports them, so a reload resumes the same conversation.
  const sessionId = state.session?.sessionId
  const savedSession = useRef(input.chatSessionId)
  savedSession.current = input.chatSessionId
  const persistSession = useCallback((id: string | undefined) => {
    if (id === savedSession.current) return
    savedSession.current = id
    onNodeData({ chatSessionId: id })
  }, [onNodeData])
  useEffect(() => { if (sessionId) persistSession(sessionId) }, [sessionId, persistSession])
  const { permissionMode } = input
  useEffect(() => { if (state.mode && state.mode !== permissionMode) onNodeData({ permissionMode: state.mode }) }, [state.mode, permissionMode, onNodeData])
  /** Raw events before the reducer: a `reset` without a known session (no init yet) still clears the stored id. */
  const noteEvents = useCallback((events: AgentChatEvent[]) => {
    for (const e of events) if (e.t === 'reset') persistSession(e.sessionId || undefined)
  }, [persistSession])

  const fail = (what: string) => (err: unknown): void => setError(`Could not ${what}: ${why(err)}`)
  /** True when the message was a command the chat handled itself (not sent). */
  const intercept = (text: string, hasImages: boolean): boolean => {
    const action = hasImages ? null : interceptOf(text)
    if (!action) return false
    setError(null)
    if (action === 'clear') transport.newConversation().catch(fail('start a new conversation'))
    else setOpenPicker((p) => ({ which: action === 'model' ? 'model' : 'history', n: (p?.n ?? 0) + 1 }))
    return true
  }

  const footer: Omit<AgentChatToolbarProps, 'modePicker'> = {
    config: state.config ?? (chatConfig ? { thinking: true, ...chatConfig } : undefined),
    context: state.context,
    costUsd: state.costUsd,
    tokens: state.tokens,
    loadModels: () => transport.models(),
    onConfigChange: (patch) => transport.setConfig(patch),
    loadSessions: () => transport.sessions(),
    onResumeSession: (id) => transport.resume(id),
    onNewSession: () => transport.newConversation(),
    disabled: stream !== 'open',
    openPicker,
  }

  return { completion, footer, intercept, noteEvents, error, dismissError: () => setError(null) }
}
