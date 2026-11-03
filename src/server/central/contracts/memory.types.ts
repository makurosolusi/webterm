// Cross-WS contract: memory block provider consumed by the context assembler (RND/29b §4.9, RND/24).
// Distinct from `memory/memoryModel.ts` names: the v7 scope set and trust ladder are wider.
import type { Awaitable } from './tool.types'

/** v7 scopes; `core` stays human-only, `scratch` is short-lived, `central`/`user`/`global` are new. */
export type MemoryBlockScope = 'project' | 'scratch' | 'core' | 'central' | 'user' | 'global'

/** Provenance ladder: human > attested (verbatim quote checked by server) > agent > external. */
export type MemoryTrust = 'human' | 'attested' | 'agent' | 'external'

/** Memory kinds from the v7 migration. */
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'procedure' | 'episode' | 'summary' | 'claim'

/** Writer of a memory row; `central` is new vs the code's `human|orchestrator|worker`. */
export interface MemoryActorRef {
  kind: 'human' | 'orchestrator' | 'worker' | 'central'
  id: string
}

/** Request to build the memory block for one turn. */
export interface MemoryBlockRequest {
  conversationId: string
  projectId: string | null
  /** Current user text, used as the retrieval query. */
  query: string
  /** Token budget for the whole block (default 2500). */
  maxTokens: number
}

/** One memory included in a block, for audit and `use_count` bookkeeping. */
export interface MemoryBlockItem {
  id: string
  scope: MemoryBlockScope
  trust: MemoryTrust
  kind: MemoryKind
  key: string
}

/** Rendered block ("data, not instructions", redacted) plus what went into it. */
export interface MemoryBlock {
  text: string
  items: readonly MemoryBlockItem[]
  truncated: boolean
}

/** Source of the memory block; the real one is WS-08, tests inject a mock. */
export interface MemoryBlockProvider {
  /** Returns an empty block (never throws) when nothing matches or the store fails. */
  block(req: MemoryBlockRequest): Awaitable<MemoryBlock>
}
