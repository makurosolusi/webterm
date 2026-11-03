// Context seam for central chat turns (RND/30 WS-02): turn service asks an assembler for the
// runtime prompt and the history ids. The default mirrors the pre-seam behaviour exactly;
// a richer assembler (WS-06) replaces the implementation, not the call site.
import type { Database } from 'bun:sqlite'
import { allRows } from '../../ledger/ledgerCore'
import { buildMemoryContext } from '../memory/contextBuilder'
import { centralPrompt } from '../proposal/centralPrompt'

/** How many prior message ids the runtime receives. */
export const HISTORY_LIMIT = 20

export interface ContextBuildInput {
  db: Database
  conversationId: string
  /** The human text of the turn being started. */
  text: string
  /** Proposal tools are advertised in the prompt (planner on and tools=write). */
  proposalsEnabled: boolean
  memoryEnabled: boolean
  now: () => number
}

export interface ContextBuildOutput {
  prompt: string
  /** Prior message ids, oldest first; call before the new human message is appended. */
  history: string[]
}

/** Builds what the runtime sees for one turn. */
export interface ContextAssembler {
  build(input: ContextBuildInput): ContextBuildOutput
}

function recentMessageIds(db: Database, conversationId: string): string[] {
  return allRows(
    db, 'SELECT id FROM central_message WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?',
    conversationId, HISTORY_LIMIT
  ).map((row) => String(row['id'])).reverse()
}

/** Default assembler: portfolio prompt plus optional project memory, last 20 message ids. */
export function createLegacyContextAssembler(): ContextAssembler {
  return {
    build({ db, conversationId, text, proposalsEnabled, memoryEnabled, now }) {
      const memory = memoryEnabled ? buildMemoryContext(db, conversationId, text, { now }) : ''
      return {
        prompt: centralPrompt(db, text, proposalsEnabled, memory),
        history: recentMessageIds(db, conversationId),
      }
    },
  }
}
