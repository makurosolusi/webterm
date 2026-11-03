// Cross-WS contract: self-knowledge port and project brief (RND/29b §4.12, RND/27).
// Every answer carries its age; stale data must be labeled, never presented as current.
import type { Awaitable } from './tool.types'

/** When and at which commit the data was gathered. */
export interface KnowledgeAsOf {
  /** Epoch ms of collection. */
  at: number
  /** Git head sha when known. */
  sha?: string
}

/** Answer wrapper for search/map: payload plus freshness. */
export interface KnowledgeAnswer<T> {
  asOf: KnowledgeAsOf
  stale: boolean
  data: T
}

/** One thing needing attention, from a pure rule over ledger state. */
export interface BriefAttention {
  /** Rule name, e.g. `approval_pending`. */
  rule: string
  evidence: string
  suggestedTool: string
}

/** Deterministic project brief (<= 800 tokens); the LLM only phrases it. */
export interface ProjectBrief {
  projectId: string
  asOf: KnowledgeAsOf
  status: string
  attention: readonly BriefAttention[]
  next: readonly string[]
  /** Names of parts that are stale (e.g. `tests`, `index`); empty when all fresh. */
  stale: readonly string[]
}

/** One hit of `kb.search`. */
export interface KnowledgeHit {
  path: string
  title: string
  snippet: string
  score: number
}

/** One module line of `kb.map`. */
export interface KnowledgeModule {
  dir: string
  summary: string
  inDegree: number
}

/** Read-only knowledge access; the index is a rebuildable cache, never authoritative. */
export interface KnowledgePort {
  /** Builds the brief for a project from ledger, nodes, git and last verification. */
  brief(projectId: string): Awaitable<ProjectBrief>
  /** Full-text search over indexed project files. */
  search(projectId: string, query: string, limit: number): Awaitable<KnowledgeAnswer<readonly KnowledgeHit[]>>
  /** Module map ordered by importance. */
  map(projectId: string): Awaitable<KnowledgeAnswer<readonly KnowledgeModule[]>>
}
