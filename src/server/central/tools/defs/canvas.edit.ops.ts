// The ops of canvas.edit: shape checks and their effect on an in-memory copy of a board. Every limit
// mirrors what a human can do in the UI; the client source of each rule is cited beside it.
import { BROWSER_KIND } from '../../../../shared/browser.contract'
import { arrange, ARRANGE_LAYOUTS, type ArrangeLayout } from '../../../../shared/canvasArrange'
import { OPEN_GAP, type Size } from '../../../../shared/canvasPlace'
import { isNodeName } from '../../../../shared/nodeNames'
import { classifyLink, isContextCapable, type BridgeLink } from '../../../../shared/workspace'
import type { CanvasNode } from '../../../canvas/canvasPush'
import { isSafeId } from './read.shared'

export const MAX_OPS = 50
export const MAX_TITLE = 80
export const MAX_COORD = 1e6
/** Largest side a resize may set. The client has no maximum; this keeps one node from burying the board. */
export const MAX_SIDE = 4000
/** The swatches the node header offers (client NodeColorSwatch.tsx `NODE_COLORS`). */
export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']
/** The client's `toFlow` default (client/store.ts) for a stored node without a size. */
const NODE_DEFAULT: Size = { width: 400, height: 300 }
/** The minWidth/minHeight each node passes its NodeLayoutResizer (client/*Node.tsx, mcpapps/McpAppNode.tsx). */
const MIN_SIZE: Record<string, Size> = {
  editor: { width: 320, height: 180 }, diff: { width: 420, height: 260 }, plan: { width: 420, height: 240 },
  agentChat: { width: 280, height: 200 }, app: { width: 280, height: 200 },
}
const MIN_DEFAULT: Size = { width: 240, height: 160 } // terminal, agent, files, browser
/** Kinds with a collapse toggle (they pass `collapsed` to NodeLayoutResizer); collapsed, they cannot be resized. */
const COLLAPSIBLE = new Set(['terminal', 'agent', 'files', 'browser', 'agentChat'])
const SIDES = ['right', 'left', 'below', 'above'] as const
type Side = (typeof SIDES)[number]
const LINK_HINT = 'A cable joins two Claude nodes, or an agent node with a browser, diff or plan node; a plan node also takes a diff node. '
  + 'Terminal, files and editor nodes take no cable.'

export type Op =
  | { op: 'move'; node: string; x: number; y: number; beside?: undefined }
  | { op: 'move'; node: string; beside: string; side?: Side }
  | { op: 'resize'; node: string; width?: number; height?: number }
  | { op: 'arrange'; nodes: string[] | 'all'; layout: ArrangeLayout }
  | { op: 'set'; node: string; title?: string | null; color?: string | null; collapsed?: boolean; hideLinks?: boolean }
  | { op: 'link'; from: string; to: string; cable?: undefined }
  | { op: 'unlink'; from: string; to: string; cable?: undefined }
  | { op: 'unlink'; cable: string }

type Obj = Record<string, unknown>
const only = (o: Obj, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k))
const ref = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)
const coord = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD
const optSide = (v: unknown): boolean => v === undefined || (coord(v) && (v as number) > 0)
const optBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean'
const title = (v: unknown): boolean => v === null || (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TITLE && !/[\x00-\x1f\x7f]/.test(v))
const color = (v: unknown): boolean => v === null || (typeof v === 'string' && NODE_COLORS.includes(v.toLowerCase()))

/** True when `v` is one well-formed op (no unknown keys). */
export function opShape(v: unknown): v is Op {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Obj
  switch (o.op) {
    case 'move':
      return ref(o.node) && (o.beside === undefined
        ? only(o, ['op', 'node', 'x', 'y']) && coord(o.x) && coord(o.y)
        : only(o, ['op', 'node', 'beside', 'side']) && ref(o.beside) && (o.side === undefined || SIDES.includes(o.side as Side)))
    case 'resize':
      return only(o, ['op', 'node', 'width', 'height']) && ref(o.node) && (o.width !== undefined || o.height !== undefined) && optSide(o.width) && optSide(o.height)
    case 'arrange':
      return only(o, ['op', 'nodes', 'layout']) && ARRANGE_LAYOUTS.includes(o.layout as ArrangeLayout)
        && (o.nodes === 'all' || (Array.isArray(o.nodes) && o.nodes.length >= 1 && o.nodes.length <= MAX_OPS && o.nodes.every(ref)))
    case 'set':
      return only(o, ['op', 'node', 'title', 'color', 'collapsed', 'hideLinks']) && ref(o.node) && Object.keys(o).length > 2
        && (o.title === undefined || title(o.title)) && (o.color === undefined || color(o.color)) && optBool(o.collapsed) && optBool(o.hideLinks)
    case 'link':
      return only(o, ['op', 'from', 'to']) && ref(o.from) && ref(o.to)
    case 'unlink':
      return o.cable === undefined ? only(o, ['op', 'from', 'to']) && ref(o.from) && ref(o.to) : only(o, ['op', 'cable']) && isSafeId(o.cable)
    default:
      return false
  }
}

/** Every node reference an op names (cable ids are not node refs). */
export function refsOf(op: Op): string[] {
  if (op.op === 'arrange') return op.nodes === 'all' ? [] : op.nodes
  if (op.op === 'link' || op.op === 'unlink') return op.cable === undefined ? [op.from, op.to] : []
  return op.op === 'move' && op.beside !== undefined ? [op.node, op.beside] : [op.node]
}

/** Mutable copy of a board; `order` is the stored node order. */
export interface Board { nodes: Map<string, CanvasNode>; order: string[]; bridges: BridgeLink[]; nameOf: Map<string, string> }
export interface Clamp { id: string; field: 'width' | 'height'; asked: number; used: number }
export type ApplyResult = { ok: true; clamped: Clamp[] } | { ok: false; code: string; data: Record<string, unknown> }

export const sizeOf = (n: CanvasNode): Size => ({ width: n.width ?? NODE_DEFAULT.width, height: n.height ?? NODE_DEFAULT.height })

/** The client's `canLink` (client/floatingEdge.ts), on stored nodes: what a hand-drawn cable may join. */
export function canLink(a: CanvasNode, b: CanvasNode): boolean {
  if (a.id === b.id) return false
  const count = (kind: string): number => (a.kind === kind ? 1 : 0) + (b.kind === kind ? 1 : 0)
  const other = (kind: string): CanvasNode => (a.kind === kind ? b : a)
  const plans = count('plan')
  if (plans) return plans === 1 && (!!other('plan').agentId || other('plan').kind === 'diff')
  const diffs = count('diff')
  if (diffs) return diffs === 1 && !!other('diff').agentId
  const browsers = count(BROWSER_KIND)
  if (!browsers) return classifyLink(a.agentId, b.agentId) === 'context'
  return browsers === 1 && !!other(BROWSER_KIND).agentId
}

const between = (b: BridgeLink, x: string, y: string): boolean => (b.source === x && b.target === y) || (b.source === y && b.target === x)

/** Applies `ops` in order to `board` (mutated); `id` maps a node ref already known to resolve. Stops at the first refused op. */
export function applyOps(board: Board, ops: Op[], id: (ref: string) => string): ApplyResult {
  const clamped: Clamp[] = []
  const node = (r: string): CanvasNode => board.nodes.get(id(r))!
  const name = (n: CanvasNode): string => board.nameOf.get(n.id) ?? n.id
  const fail = (code: string, data: Record<string, unknown>): ApplyResult => ({ ok: false, code, data })
  for (const op of ops) {
    if (op.op === 'move' && op.beside === undefined) {
      Object.assign(node(op.node), { x: op.x, y: op.y })
    } else if (op.op === 'move') {
      const n = node(op.node)
      const b = node(op.beside)
      if (n === b) return fail('same_node', { node: name(n) })
      const ns = sizeOf(n), bs = sizeOf(b)
      const side = op.side ?? 'right'
      n.x = side === 'right' ? b.x + bs.width + OPEN_GAP : side === 'left' ? b.x - ns.width - OPEN_GAP : b.x
      n.y = side === 'below' ? b.y + bs.height + OPEN_GAP : side === 'above' ? b.y - ns.height - OPEN_GAP : b.y
    } else if (op.op === 'resize') {
      const n = node(op.node)
      if (n.collapsed && COLLAPSIBLE.has(n.kind)) {
        return fail('node_collapsed', { node: name(n), hint: `Expand it first: {"op":"set","node":"${name(n)}","collapsed":false}` })
      }
      const min = MIN_SIZE[n.kind] ?? MIN_DEFAULT
      for (const field of ['width', 'height'] as const) {
        const asked = op[field]
        if (asked === undefined) continue
        const used = Math.min(MAX_SIDE, Math.max(min[field], asked))
        if (used !== asked) clamped.push({ id: n.id, field, asked, used })
        n[field] = used
      }
    } else if (op.op === 'arrange') {
      const ids = op.nodes === 'all' ? board.order : [...new Set(op.nodes.map(id))]
      const nodes = ids.map((i) => board.nodes.get(i)!)
      if (!nodes.length) continue
      const origin = { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) }
      for (const p of arrange(nodes.map((n) => ({ id: n.id, ...sizeOf(n) })), op.layout, origin)) Object.assign(board.nodes.get(p.id)!, { x: p.x, y: p.y })
    } else if (op.op === 'set') {
      const n = node(op.node)
      if (op.collapsed !== undefined && !COLLAPSIBLE.has(n.kind)) return fail('field_not_supported', { node: name(n), field: 'collapsed' })
      // Only an agent node of a context-capable harness offers the toggle (client AgentNode.tsx `onToggleHideLinksProp`).
      if (op.hideLinks !== undefined && !(n.kind === 'agent' && isContextCapable(n.agentId))) return fail('field_not_supported', { node: name(n), field: 'hideLinks' })
      if (op.title === null) delete n.title
      else if (op.title !== undefined) n.title = op.title.trim()
      if (op.color === null) delete n.color
      else if (op.color !== undefined) n.color = op.color.toLowerCase()
      if (op.collapsed !== undefined) n.collapsed = op.collapsed
      if (op.hideLinks !== undefined) n.hideLinks = op.hideLinks
    } else if (op.cable !== undefined) {
      const cable = op.cable
      if (!board.bridges.some((b) => b.id === cable)) return fail('link_not_found', { cable })
      board.bridges = board.bridges.filter((b) => b.id !== cable)
    } else {
      const a = node(op.from)
      const b = node(op.to)
      const has = board.bridges.some((x) => between(x, a.id, b.id))
      if (op.op === 'unlink') {
        if (!has) return fail('link_not_found', { from: name(a), to: name(b) })
        board.bridges = board.bridges.filter((x) => !between(x, a.id, b.id))
      } else if (!canLink(a, b)) {
        return fail('link_not_allowed', { from: name(a), to: name(b), hint: LINK_HINT })
      } else if (!has) {
        // Same id and kind as a hand-drawn cable (client App.board.ts `onConnect`); an existing pair is a no-op (`bridgeExists`).
        board.bridges.push({ id: `bridge-${a.id}-${b.id}`, source: a.id, target: b.id, kind: 'context' })
      }
    }
  }
  return { ok: true, clamped }
}
