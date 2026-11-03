// Cross-WS contract: context assembler seam (RND/29 §4.2 step 3). Mirrors the `contextPort.ts`
// seam created by WS-02 (`build(input) -> { prompt, history }`); this file does not replace it.
import type { Awaitable } from './tool.types'

/** What the turn service knows when it needs a prompt. */
export interface ContextBuildInput {
  conversationId: string
  turnId: string
  /** Null for the global conversation. */
  projectId: string | null
  /** The user's text; always placed last in the prompt. */
  text: string
}

/** Prompt text plus the ordered prior message ids passed to the runtime as `history`. */
export interface ContextBuildResult {
  prompt: string
  history: readonly string[]
}

/** Order: static prefix, checkpoint, memory, state header, user text; no timestamp above the text. */
export interface ContextAssembler {
  /** Builds the prompt for one turn. */
  build(input: ContextBuildInput): Awaitable<ContextBuildResult>
}
