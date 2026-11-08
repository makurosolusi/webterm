// The Central chat's model: `/model` writes the conversation's choice server-side
// (GET/POST /api/central/conversations/:id/model) and the header badge shows what the next turn runs on.
import { useEffect, useState } from 'react'
import { CHAT_PATH, requestJson } from '../chat/chatTransport'
import type { EffortArg, ModelArg } from './centralCommands'

/** Server `ConversationModelState`, the fields the badge reads. */
export interface CentralModelState {
  alias: string | null
  effort: string | null
  tier: string
  /** A `/model` choice waits for the fresh session the next message starts. */
  pending: boolean
}

const path = (conversationId: string): string => `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/model`

export function fetchCentralModel(conversationId: string, signal?: AbortSignal): Promise<CentralModelState> {
  return requestJson<CentralModelState>(path(conversationId), { method: 'GET', ...(signal ? { signal } : {}) })
}

/** Stores `/model <model> [effort]`; the server posts the confirming notice into the chat itself. */
export function setCentralModel(conversationId: string, model: ModelArg, effort?: EffortArg): Promise<CentralModelState> {
  return requestJson<CentralModelState>(path(conversationId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, ...(effort ? { effort } : {}) }),
  })
}

/** "sonnet · medium · T2", plus "next session" while a switch waits; hidden until loaded or on error. */
export function CentralModelBadge(props: { conversationId: string; refreshKey: number; load?: typeof fetchCentralModel }) {
  const [state, setState] = useState<CentralModelState | null>(null)
  const load = props.load ?? fetchCentralModel
  useEffect(() => {
    const abort = new AbortController()
    // A failed read only hides the badge: the chat itself reports runtime problems.
    load(props.conversationId, abort.signal).then(setState, () => { if (!abort.signal.aborted) setState(null) })
    return () => abort.abort()
  }, [props.conversationId, props.refreshKey, load])
  if (!state) return null
  const text = [state.alias ?? 'default', state.effort, state.tier].filter(Boolean).join(' · ')
  return (
    <span className="chat-model-badge" title={state.pending ? 'New model starts with a fresh session on your next message' : 'Model for this chat (/model to change)'}>
      {text}{state.pending ? ' · next session' : ''}
    </span>
  )
}
