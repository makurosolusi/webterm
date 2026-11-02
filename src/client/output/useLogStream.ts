// Hook over the shared log stream store (see logStreamStore.ts). Every caller sees the same
// entries, so Clear Output from a menu or the palette empties the panel too.
import { useMemo, useSyncExternalStore } from 'react'
import type { LogChannelInfo, LogEntry, LogLevel } from '../../shared/logEntry'
import {
  clearLogStream,
  getLogStreamState,
  setLogStreamLevel,
  subscribeLogStream,
  type LogConnection,
} from './logStreamStore'

export interface UseLogStream {
  entries: LogEntry[]
  channels: LogChannelInfo[]
  level: LogLevel
  counts: { error: number; warn: number }
  clear: () => Promise<void>
  setLevel: (level: LogLevel) => Promise<void>
  connection: LogConnection
}

/** Subscribe to the shared log stream (backfill + SSE, reconnecting). */
export function useLogStream(): UseLogStream {
  const state = useSyncExternalStore(subscribeLogStream, getLogStreamState, getLogStreamState)
  return useMemo(
    () => ({ ...state, clear: clearLogStream, setLevel: setLogStreamLevel }),
    [state],
  )
}
