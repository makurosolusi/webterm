// Settings › Memory: what agents remember and share (AgentMemory, which also renders the proposals and the
// shared board from AgentMemoryBoard), then Central's own memory, read-only (moved here from the Central panel).
import { AgentMemory } from './AgentMemory'
import MemoryView from './central/MemoryView'
import { useCentralControlEnabled } from './central/centralControlApi'

/** Memory section body. */
export function MemorySection(): React.JSX.Element {
  const central = useCentralControlEnabled()
  return <div className="flex flex-col gap-3 text-[13px]" data-testid="memory-section"><AgentMemory />{central && <MemoryView />}</div>
}
