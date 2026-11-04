// Production `Summarize` without a model call: carries the tail of the previous narrative forward and appends
// the heads of the newest messages. Central's summarizer below rotation (checkpointLlm.createCentralSummarize)
// (source `auto`, model `deterministic`); near rotation the model summary takes over.
import { CHECKPOINT_NARRATIVE_MAX } from '../../ledger/ledgerSchemaV8'
import type { Summarize } from './checkpointSummarizer'

const KEEP_MESSAGES = 8
const MESSAGE_HEAD_CHARS = 160

/** Rolling narrative; the newest text always survives the column cap (ponytail: may cut the oldest line mid-way). */
export const rollingSummarize: Summarize = async ({ previousNarrative, messages }) => {
  const lines = messages.slice(-KEEP_MESSAGES).map((m) => `${m.role}: ${m.text.replace(/\s+/g, ' ').slice(0, MESSAGE_HEAD_CHARS)}`)
  const narrative = [previousNarrative ?? '', ...lines].filter((part) => part !== '').join('\n').slice(-CHECKPOINT_NARRATIVE_MAX)
  return { narrative, model: 'deterministic' }
}
