// Wires the handle spawn menu into the canvas: a click on a bridge handle, or a cable released on the empty
// pane, opens the menu; picking an entry spawns the node beside the origin and cables it. Per instance
// (refs + state in the hook), no module singletons.
//
// A click is not a separate event in React Flow: with `connectOnClick` off, pointer-down on a handle still
// fires onConnectStart and pointer-up onConnectEnd, with no target. So "click" = start and end within a few px.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { FinalConnectionState, Node, OnConnectStartParams } from '@xyflow/react'
import { HandleMenuView } from './handleMenu.view'
import { buildHandleEntries, cableFor, spawnCenter } from './handleMenu.model'
import type { HandleEntry, HandleOrigin, HandleSpawners } from './handleMenu.model'
import type { AgentId } from '../shared/workspace'
import type { Settings } from '../shared/settings'

const CLICK_SLOP_PX = 5
/** A spawn that never produced a node (async capability) stops waiting for its cable after this. */
const PENDING_MS = 3000

export interface HandleMenuDeps {
  nodes: Node[]
  settings: Pick<Settings, 'disabledAgents' | 'customAgents' | 'agentLaunchCommands' | 'defaultNodeWidth' | 'defaultNodeHeight'>
  /** Frames the origin and the new node (the camera call lives in App.canvas.tsx: camera policy). */
  frame: (ids: string[]) => void
  /** Absent (no provider, tests) = the menu never opens. */
  spawn?: HandleSpawners
}

interface Pending { origin: HandleOrigin; before: Set<string>; at: number }

const pointOf = (e: MouseEvent | TouchEvent): { x: number; y: number } => {
  const p = 'changedTouches' in e ? e.changedTouches[0] : e
  return { x: p?.clientX ?? 0, y: p?.clientY ?? 0 }
}

const sizeOf = (n: Node, d: { width: number; height: number }) => ({ width: n.measured?.width ?? n.width ?? d.width, height: n.measured?.height ?? n.height ?? d.height })
const rectOf = (n: Node, d: { width: number; height: number }) => ({ ...n.position, ...sizeOf(n, d) })

/** `onConnectStart`/`onConnectEnd` for <ReactFlow connectOnClick={false}> plus the menu element (null when closed). */
export function useHandleMenu({ nodes, settings, spawn, frame }: HandleMenuDeps) {
  const [open, setOpen] = useState<{ point: { x: number; y: number }; origin: HandleOrigin } | null>(null)
  const start = useRef<{ x: number; y: number; nodeId: string; side: HandleOrigin['side'] } | null>(null)
  const pending = useRef<Pending | null>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const close = useCallback(() => setOpen(null), [])

  const onConnectStart = useCallback((e: MouseEvent | TouchEvent, p: OnConnectStartParams) => {
    start.current = p.nodeId && p.handleType && p.handleId?.startsWith('link-') ? { ...pointOf(e), nodeId: p.nodeId, side: p.handleType } : null
  }, [])

  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const from = start.current
    start.current = null
    if (!from || !spawn || state.isValid) return // a real cable was made: nothing to offer
    const p = pointOf(e)
    const click = Math.hypot(p.x - from.x, p.y - from.y) < CLICK_SLOP_PX
    const onPane = (e.target as Element | null)?.classList?.contains('react-flow__pane') === true
    if (!click && !onPane) return // released on a node: today's behaviour
    const n = nodesRef.current.find((x) => x.id === from.nodeId)
    if (!n) return
    const agentId = (n.data as { agentId?: AgentId } | undefined)?.agentId
    setOpen({ point: p, origin: { id: n.id, kind: n.type, agentId, side: from.side } })
  }, [spawn])

  const ctx = useMemo(
    () => ({ nodeCount: nodes.length, disabledAgents: settings.disabledAgents, customAgents: settings.customAgents, agentLaunchCommands: settings.agentLaunchCommands }),
    [nodes.length, settings.disabledAgents, settings.customAgents, settings.agentLaunchCommands],
  )
  const entries = useMemo(() => (open && spawn ? buildHandleEntries(spawn, ctx, open.origin) : []), [open, spawn, ctx])

  const pick = useCallback((entry: HandleEntry) => {
    if (!open) return
    const d = { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight }
    const all = nodesRef.current
    const origin = all.find((x) => x.id === open.origin.id)
    if (!origin) return setOpen(null)
    const others = all.filter((x) => x.id !== origin.id).map((x) => rectOf(x, d))
    pending.current = { origin: open.origin, before: new Set(all.map((x) => x.id)), at: Date.now() }
    entry.spawn(spawnCenter(rectOf(origin, d), d, open.origin.side, others))
    setOpen(null)
  }, [open, settings.defaultNodeWidth, settings.defaultNodeHeight])

  // The spawners do not return the new id: the node that appears next is the one to cable and frame.
  useEffect(() => {
    const p = pending.current
    if (!p || !spawn) return
    if (Date.now() - p.at > PENDING_MS) { pending.current = null; return }
    const fresh = nodes.filter((n) => !p.before.has(n.id)).at(-1)
    if (!fresh) return
    pending.current = null
    spawn.link(cableFor(p.origin.id, fresh.id, p.origin.side))
    frame([p.origin.id, fresh.id])
  }, [nodes, spawn, frame])

  const menu: ReactNode = open && spawn
    ? <HandleMenuView point={open.point} side={open.origin.side} entries={entries} onPick={pick} onClose={close} />
    : null
  return { onConnectStart, onConnectEnd, menu }
}
