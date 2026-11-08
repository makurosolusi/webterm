// Settings › Memory: what agents remember and share (AgentMemory, which also renders the proposals and the
// shared board from AgentMemoryBoard).
import { AgentMemory } from './AgentMemory'

/** Memory section body. */
export function MemorySection(): React.JSX.Element {
  return <div className="flex flex-col gap-3 text-[13px]" data-testid="memory-section"><AgentMemory /></div>
}
