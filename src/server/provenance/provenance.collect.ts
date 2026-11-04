// Gathers the provenance inputs for one node from the live process: board, ledger, git, MCP registry.
// Reconstructed now from the same renderers the hooks use, so it shows what a session started now
// gets; hook-time recording would need the hook path to report back (not wired yet).
import type { Database } from 'bun:sqlite'
import type { Workspace } from '../../shared/workspace'
import { renderCard } from '../awareness/awarenessCard'
import { listProcedural, proceduralBlock } from '../awareness/proceduralMemory'
import { findWorkspaceFor } from '../contextLinkRoute'
import { enabledSet } from '../featureCapabilities.runtime'
import { houseRulesPath } from '../hooksPaths'
import { readGitState } from '../knowledge/knowledgeFresh'
import { git } from '../knowledge/knowledgeScan'
import { KnowledgeError } from '../knowledge/knowledgeStore'
import { buildRepoMap } from '../knowledge/repoMapCache'
import { type RuleFile, discoverRules, rulesBlock } from '../rules/rulesLoader'
import { EXPLORE_AGENT_MD, EXPLORE_AGENT_NAME, EXPLORE_PLUGIN_NAME } from '../subagents/exploreAgent'
import { HOUSE_RULES, renderAwareness } from '../webtermAwareness'
import { type Provenance, buildProvenance } from './provenance'

export interface CollectDeps {
  workspaces(): Workspace[]
  ledger(): Database | null
  repoMapDb(): Database
  mcpTools(): Promise<string[]>
}

export interface NodeContext { ws: Workspace; nodeId: string; cwd: string; root: string | null; touched: string[] }

/** Board, folder and git root of a node; `extra` = files the UI says are open. Null when the node is not on a board. */
export async function nodeContext(deps: Pick<CollectDeps, 'workspaces'>, nodeId: string, extra: readonly string[] = []): Promise<NodeContext | null> {
  const ws = findWorkspaceFor(deps.workspaces(), nodeId)
  if (!ws) return null
  const cwd = ws.nodes.find((n) => n.id === nodeId)?.cwd || ws.cwd || ''
  const root = cwd ? (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null : null
  const dirty = root ? (await readGitState(root)).dirty : []
  return { ws, nodeId, cwd, root, touched: [...new Set([...dirty, ...extra])] }
}

/** Rules of the node's repo with the block webterm would add now. */
export async function nodeRules(ctx: NodeContext): Promise<{ rules: RuleFile[]; block: ReturnType<typeof rulesBlock> }> {
  const rules = ctx.root ? await discoverRules(ctx.root) : []
  return { rules, block: rulesBlock(rules, ctx.touched) }
}

/** The provenance list of one node. */
export async function collectProvenance(deps: CollectDeps, ctx: NodeContext): Promise<Provenance & { root: string | null; touched: string[] }> {
  const db = deps.ledger()
  const facts = db ? listProcedural(db).filter((f) => f.status === 'verified').length : 0
  const { rules } = await nodeRules(ctx)
  let repoMap = null
  if (ctx.root) {
    try { repoMap = await buildRepoMap(deps.repoMapDb(), ctx.root, { focus: ctx.touched }) } catch (err) {
      if (!(err instanceof KnowledgeError)) throw err
    }
  }
  const out = buildProvenance({
    houseRules: { text: HOUSE_RULES, source: `--append-system-prompt-file ${houseRulesPath()}` },
    awareness: renderAwareness(ctx.ws, ctx.nodeId, enabledSet()),
    card: renderCard(ctx.ws, ctx.nodeId, () => undefined).text,
    procedural: { text: db ? proceduralBlock(db) : '', count: facts },
    rules, touched: ctx.touched,
    mcpTools: await deps.mcpTools(),
    subagent: { name: `${EXPLORE_PLUGIN_NAME}:${EXPLORE_AGENT_NAME}`, text: EXPLORE_AGENT_MD, source: '--plugin-dir (webterm claude-plugin)' },
    repoMap,
    handoff: null, // ponytail: no handoff card exists yet (F5-c); pass it here once central/context ships one.
  })
  return { ...out, root: ctx.root, touched: ctx.touched }
}
