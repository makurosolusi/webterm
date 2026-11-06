// Workspace board schema, shared by the write path (PUT body) and the read path (stored row), like
// `normalizeTabLayout` for the layout. A board crosses two trust boundaries: an HTTP body anyone
// with the API can send, and a SQLite row an older/newer build or a hand edit may have written.
// One function coerces both; the WRITE path refuses any input that needed coercing (400, row
// untouched), the READ path keeps the coerced board and logs what it dropped, so one bad node or
// blob never blanks the app or fails the whole list.
import { DEFAULT_VIEWPORT, validDiffNotes, validPlanData, type BridgeLink, type Viewport, type WsNode, type WsNodeKind } from './workspace.shape'

const KINDS: Record<WsNodeKind, true> = { terminal: true, agent: true, files: true, editor: true, browser: true, diff: true, plan: true, app: true }

/** The persisted board fields of a workspace (identity, version and layout are handled elsewhere). */
export interface WorkspaceBoard { name: string; cwd?: string; color?: string; viewport: Viewport; nodes: WsNode[]; bridges: BridgeLink[] }

/** A normalized board plus every problem found; `issues` empty = the input was already valid. */
export interface NormalizedWorkspace { board: WorkspaceBoard; issues: string[] }

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string' && v !== ''
const optText = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string'

function nodeIssue(n: unknown): string | null {
  if (!obj(n)) return 'is not an object'
  if (!text(n.id)) return 'id must be a non-empty string'
  if (typeof n.kind !== 'string' || !(n.kind in KINDS)) return 'kind is not a known node kind'
  if (!finite(n.x) || !finite(n.y)) return 'x and y must be finite numbers'
  return null
}

/** A valid node with its free-form blobs sanitized; unknown fields survive (newer builds' data). */
function cleanNode(n: Record<string, unknown>): WsNode {
  const node = { ...n } as unknown as WsNode
  if (n.diffNotes !== undefined) node.diffNotes = validDiffNotes(n.diffNotes)
  if (n.plan !== undefined) {
    const plan = validPlanData(n.plan)
    if (plan) node.plan = plan
    else delete node.plan
  }
  return node
}

const validBridge = (b: unknown): b is Record<'id' | 'source' | 'target', string> & { kind?: unknown } =>
  obj(b) && text(b.id) && text(b.source) && text(b.target)

/**
 * Coerce an untrusted board (`raw` = a PUT body or a parsed row). Bad viewport -> default, a
 * non-array -> [], an invalid node or bridge -> dropped; each one is reported in `issues`.
 * `bridges` absent is valid (old writers); `viewport`/`nodes` absent are not.
 */
export function normalizeWorkspace(raw: Record<string, unknown>): NormalizedWorkspace {
  const issues: string[] = []
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) issues.push('name must be a non-empty string')
  for (const k of ['cwd', 'color'] as const) if (!optText(raw[k])) issues.push(`${k} must be a string`)
  const v = raw.viewport
  const viewport = obj(v) && finite(v.x) && finite(v.y) && finite(v.zoom) && v.zoom > 0 ? { x: v.x, y: v.y, zoom: v.zoom } : DEFAULT_VIEWPORT
  if (viewport === DEFAULT_VIEWPORT) issues.push('viewport must be {x, y, zoom} finite numbers with zoom > 0')
  const nodes: WsNode[] = []
  if (!Array.isArray(raw.nodes)) issues.push('nodes must be an array')
  else raw.nodes.forEach((n, i) => {
    const issue = nodeIssue(n)
    if (issue) issues.push(`nodes[${i}] ${issue}`)
    else nodes.push(cleanNode(n as Record<string, unknown>))
  })
  const bridges: BridgeLink[] = []
  if (raw.bridges !== undefined && !Array.isArray(raw.bridges)) issues.push('bridges must be an array')
  else (raw.bridges as unknown[] | undefined ?? []).forEach((b, i) => {
    // Kind absent (rows from before `kind`) = 'context', exactly like the client's `toBridge`.
    if (validBridge(b)) bridges.push({ id: b.id, source: b.source, target: b.target, kind: b.kind === 'file' ? 'file' : 'context' })
    else issues.push(`bridges[${i}] must have non-empty string id, source and target`)
  })
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
  return { board: { name, cwd: str(raw.cwd), color: str(raw.color), viewport, nodes, bridges }, issues }
}
