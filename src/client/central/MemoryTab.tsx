// Control › Memory: one place for everything agents remember (moved out of Settings, settings overhaul W2c).
// One filter bar (AgentMemoryFilters.tsx): Source = All, Suggested (waiting for your OK), Notes (the shared board)
// or Central (its own memory, only while Central is on); Kind = what the remembered list shows (Source: All only).
import { useState } from 'react'
import { AgentMemory, type MemoryKindFilter } from '../AgentMemory'
import { MemoryFilters, type MemorySource } from '../AgentMemoryFilters'
import MemoryView from './MemoryView'
import type { CentralControlClient } from './centralControlTypes'

/** `central` = the Central Agent is on (its memory can be read). */
export default function MemoryTab({ client, central }: { client: CentralControlClient; central: boolean }): React.JSX.Element {
  const [source, setSource] = useState<MemorySource>('all')
  const [kind, setKind] = useState<MemoryKindFilter>('all')
  const shown = !central && source === 'central' ? 'all' : source
  const filters = <MemoryFilters source={shown} kind={kind} central={central} onSource={setSource} onKind={setKind} />
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="memory-tab">
      {shown !== 'central' ? <AgentMemory part={shown} kind={kind} filters={filters} /> : <div className="text-xs">{filters}</div>}
      {central && (shown === 'all' || shown === 'central') ? <MemoryView client={client} /> : null}
    </div>
  )
}
