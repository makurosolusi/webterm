// Control › Memory: one place for everything agents remember (moved out of Settings, settings overhaul W2c).
// One filter over the parts: All, Suggested (waiting for your OK), Notes (the shared board) and Central (its own
// memory, only while Central is on).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { AgentMemory } from '../AgentMemory'
import MemoryView from './MemoryView'
import type { CentralControlClient } from './centralControlTypes'

export const MEMORY_TAB_TEXT = {
  filter: 'Show',
  filters: { all: 'All', suggested: 'Suggested', notes: 'Notes', central: 'Central' },
} as const
type Filter = keyof typeof MEMORY_TAB_TEXT.filters

/** `central` = the Central Agent is on (its memory can be read). */
export default function MemoryTab({ client, central }: { client: CentralControlClient; central: boolean }): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const filters = (Object.keys(MEMORY_TAB_TEXT.filters) as Filter[]).filter((f) => central || f !== 'central')
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="memory-tab">
      <div role="group" aria-label={MEMORY_TAB_TEXT.filter} className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <Button key={f} size="sm" variant={f === filter ? 'default' : 'secondary'} aria-pressed={f === filter} onClick={() => setFilter(f)}>
            {MEMORY_TAB_TEXT.filters[f]}
          </Button>
        ))}
      </div>
      {filter !== 'central' ? <AgentMemory part={filter} /> : null}
      {central && (filter === 'all' || filter === 'central') ? <MemoryView client={client} /> : null}
    </div>
  )
}
