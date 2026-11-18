// Spawning browser nodes on chosen profiles. `useBrowserProfileSpawn` (App.board) turns the board's add path into a
// `ProfileSpawner` and registers it; menus, the Dock and the command palette only call `openProfileSpawn`, which
// opens the dialog (BrowserProfileSpawnDialog) without any prop plumbing through the menus.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { Node, ReactFlowInstance, XYPosition } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import type { BrowserProfile } from '../shared/browser.profile'
import { BROWSER_OPEN_SIZE, FIT_DURATION_MS, FIT_MAX_ZOOM, FIT_MIN_ZOOM, FIT_PADDING } from './browser.open.place'
import { gridPositions } from './browserProfile.layout'
import { randomId } from './randomId'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

export interface ProfileSpawner {
  /** One browser on `profile`, centred on `at` (default: the middle of the view). */
  openOne: (profile: BrowserProfile, at?: XYPosition) => void
  /** One browser per profile in a grid; at most `limit` open (the rest are skipped). Returns how many opened. */
  openMany: (profiles: readonly BrowserProfile[], limit?: number) => number
}

export type SpawnMode = 'one' | 'each'
export interface SpawnRequest { mode: SpawnMode; at?: XYPosition }

let spawner: ProfileSpawner | null = null
let request: SpawnRequest | null = null
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of [...listeners]) l() }

/** Ask the host to show the profile dialog (`one` = pick a profile, `each` = tick several). */
export function openProfileSpawn(mode: SpawnMode, at?: XYPosition): void {
  if (!spawner) return
  request = { mode, at }
  emit()
}

export function closeProfileSpawn(): void {
  if (request) { request = null; emit() }
}

/** The pending request and the spawner that serves it (both null while the dialog is closed). */
export function useProfileSpawn(): { request: SpawnRequest | null; spawner: ProfileSpawner | null } {
  const req = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => request)
  return { request: req, spawner }
}

interface SpawnDeps {
  enabled: boolean
  addFlowNode: AddFlowNode
  nodesRef: RefObject<Node[]>
  rf: RefObject<ReactFlowInstance | null>
  /** The board's default node size: `addFlowNode` centres a node of THIS size on `at`. */
  defaultSize: { width: number; height: number }
}

const nodeRect = (n: Node): { x: number; y: number; width: number; height: number } =>
  ({ ...n.position, width: n.measured?.width ?? n.width ?? 400, height: n.measured?.height ?? n.height ?? 300 })

/** Builds and registers the spawner while the browser feature is on. */
export function useBrowserProfileSpawn({ enabled, addFlowNode, nodesRef, rf, defaultSize }: SpawnDeps): void {
  const { width: dw, height: dh } = defaultSize
  const make = useCallback((profile: BrowserProfile, id: string) => (_: number, ws: Workspace): Omit<WsNode, 'x' | 'y'> => ({
    id, kind: 'browser', width: BROWSER_OPEN_SIZE.width, height: BROWSER_OPEN_SIZE.height,
    // The board's own Default stays "no profileId", so a copied board never points at another board's id.
    ...(profile.isDefaultOf === ws.id ? {} : { profileId: profile.id }),
  }), [])
  const openOne = useCallback((profile: BrowserProfile, at?: XYPosition): void => {
    addFlowNode(make(profile, randomId()), at)
  }, [addFlowNode, make])
  const openMany = useCallback((profiles: readonly BrowserProfile[], limit = Infinity): number => {
    const chosen = profiles.slice(0, Math.max(0, limit))
    const view = rf.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 0, y: 0 }
    const spots = gridPositions(chosen.length, BROWSER_OPEN_SIZE, view, (nodesRef.current ?? []).map(nodeRect))
    const ids = chosen.map((p, i) => {
      const id = randomId()
      // `at` is the CENTRE of a default-size node (addFlowNode subtracts dw/2, dh/2), so shift the grid's top-left by that.
      addFlowNode(make(p, id), { x: spots[i].x + dw / 2, y: spots[i].y + dh / 2 })
      return id
    })
    if (ids.length) requestAnimationFrame(() => { void rf.current?.fitView({ nodes: ids.map((id) => ({ id })), padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS }) })
    return ids.length
  }, [addFlowNode, make, nodesRef, rf, dw, dh])
  useEffect(() => {
    if (!enabled) return undefined
    const mine: ProfileSpawner = { openOne, openMany }
    spawner = mine
    emit()
    return () => { if (spawner === mine) { spawner = null; request = null; emit() } }
  }, [enabled, openOne, openMany])
}
