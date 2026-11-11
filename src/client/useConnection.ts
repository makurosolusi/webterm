// React view of the shared socket's connection store (ws.connection.ts).
import { useSyncExternalStore } from 'react'
import { getConnection, subscribeConnection, type ConnectionPhase, type ConnectionState } from './ws.connection'

/** Why a server action is unavailable while the socket is down (send buttons, Retry). */
export const OFFLINE_REASON = 'Offline — available when reconnected'

/**
 * True once a connection that was up is lost (`reconnecting`) or the network is gone (`offline`).
 * `connecting` is not "disconnected": at boot nothing was lost yet, and the first connect is fast.
 */
export function isDisconnected(phase: ConnectionPhase): boolean {
  return phase === 'reconnecting' || phase === 'offline'
}

/** Current connection state; re-renders on every change. */
export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribeConnection, getConnection)
}

/** Shorthand for components that only gate on "can I reach the server right now". */
export function useDisconnected(): boolean {
  return isDisconnected(useConnection().phase)
}
