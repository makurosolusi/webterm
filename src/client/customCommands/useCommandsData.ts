// Loads what the custom-commands panel shows (detected tools + tool folders); one instance per panel.
import { useCallback, useEffect, useState } from 'react'
import { errorCause } from '@/components/ui/action'
import type { CustomCommandDetected } from '../../shared/customCommands'
import { fetchDetected, fetchPaths, type CommandPaths } from './commands.api'

export type CommandsData =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detected: CustomCommandDetected[]; paths: CommandPaths }

/** `data` plus `reload()`; a reload keeps showing the previous data until the new one arrives. */
export function useCommandsData(): { data: CommandsData; reload(): Promise<void> } {
  const [data, setData] = useState<CommandsData>({ status: 'loading' })
  const reload = useCallback(async (): Promise<void> => {
    try {
      const [detected, paths] = await Promise.all([fetchDetected(), fetchPaths()])
      setData({ status: 'ready', detected, paths })
    } catch (e) {
      setData({ status: 'error', message: errorCause(e) })
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { data, reload }
}
