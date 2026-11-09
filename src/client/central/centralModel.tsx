// The Central chat's model: `/model` writes the conversation's choice server-side
// (GET/POST /api/central/conversations/:id/model); the header picker (centralModelPicker) shows and changes it.
import { CHAT_PATH, requestJson } from '../chat/chatTransport'
import type { EffortArg, ModelArg } from './centralCommands'

/** Server `ConversationModelState`, the fields the picker reads. */
export interface CentralModelState {
  /** What the next turn runs on: the ladder-resolved alias even on Auto. */
  alias: string | null
  effort: string | null
  tier: string
  /** A `/model` choice waits for the fresh session the next message starts. */
  pending: boolean
  /** The conversation's own `/model` choice; null = Auto (no override, the setting or the ladder decides). */
  override: { model: string; effort?: string } | null
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
