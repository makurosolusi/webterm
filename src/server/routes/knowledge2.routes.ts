// Context provenance, project rules and repo map per node (F5-e): `/api/knowledge2/*`, GET only.
// Read-only views for the UI; the agent-facing surface is the `repo.map` tool (knowledge/repoMap.def.ts).
import { db } from '../db'
import { repoMapDb } from '../knowledge/repoMap.def'
import { buildRepoMap } from '../knowledge/repoMapCache'
import { REPO_MAP_MAX_TOKENS } from '../knowledge/repoMapRank'
import { KnowledgeError } from '../knowledge/knowledgeStore'
import { type CollectDeps, collectProvenance, nodeContext, nodeRules } from '../provenance/provenance.collect'
import { json, type ApiRoute } from './route.core'

export const KNOWLEDGE2_PREFIX = '/api/knowledge2'
const MAX_FILES_PARAM = 50

/** Names of the MCP tools a node sees (same list `webterm mcp` serves). */
async function mcpTools(): Promise<string[]> {
  const [{ listTools }, { processMcpDeps }] = await Promise.all([import('../mcp/mcp.tools'), import('../mcp/mcp.route')])
  return listTools(await processMcpDeps()).map((t) => t.name)
}

export const knowledge2Routes: ApiRoute[] = [
  {
    name: 'knowledge2',
    match: (c) => c.path.startsWith(`${KNOWLEDGE2_PREFIX}/`),
    handle: async (c) => {
      if (c.method !== 'GET') { json(c.res, 405, { error: 'method_not_allowed' }); return true }
      const nodeId = c.url.searchParams.get('nodeId') ?? ''
      if (!nodeId) { json(c.res, 400, { error: 'node_id_required' }); return true }
      const files = c.url.searchParams.getAll('file').filter((f) => f && !f.startsWith('/') && !f.split('/').includes('..')).slice(0, MAX_FILES_PARAM)
      const deps: CollectDeps = { workspaces: () => db.list(), ledger: () => c.ledger()?.db ?? null, repoMapDb, mcpTools }
      const ctx = await nodeContext(deps, nodeId, files)
      if (!ctx) { json(c.res, 404, { error: 'node_not_found' }); return true }
      const sub = c.path.slice(KNOWLEDGE2_PREFIX.length)
      if (sub === '/provenance') {
        json(c.res, 200, await collectProvenance(deps, ctx))
        return true
      }
      if (sub === '/rules') {
        const { rules, block } = await nodeRules(ctx)
        json(c.res, 200, { root: ctx.root, touched: ctx.touched, rules: rules.map(({ body: _body, ...r }) => r), block })
        return true
      }
      if (sub === '/repo-map') {
        if (!ctx.root) { json(c.res, 409, { error: 'not_git' }); return true }
        const max = Number(c.url.searchParams.get('maxTokens'))
        try {
          json(c.res, 200, await buildRepoMap(repoMapDb(), ctx.root, { focus: ctx.touched, ...(Number.isInteger(max) && max > 0 ? { maxTokens: Math.min(max, REPO_MAP_MAX_TOKENS) } : {}) }))
        } catch (err) {
          if (!(err instanceof KnowledgeError)) throw err
          json(c.res, 409, { error: err.code })
        }
        return true
      }
      json(c.res, 404, { error: 'unknown route' })
      return true
    },
  },
]
