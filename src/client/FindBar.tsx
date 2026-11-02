import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Small floating find bar inside a node; drives TerminalCore's search handle.
export default function FindBar({ onSearch, onClose }: {
  onSearch: (term: string, direction: 'next' | 'prev') => void
  onClose: () => void
}) {
  const [term, setTerm] = useState('')
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); onSearch(term, e.shiftKey ? 'prev' : 'next') }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  return (
    <div className="nodrag absolute top-1.5 right-1.5 z-20 flex items-center gap-1 rounded-lg border border-border bg-[rgb(var(--card-rgb))] p-1">
      <Input autoFocus value={term} placeholder="Find…" className="w-[140px]"
        onChange={(e) => setTerm(e.target.value)} onKeyDown={onKey} />
      <Button variant="ghost" size="icon-xs" title="Previous" onClick={() => onSearch(term, 'prev')}>‹</Button>
      <Button variant="ghost" size="icon-xs" title="Next" onClick={() => onSearch(term, 'next')}>›</Button>
      <Button variant="ghost" size="icon-xs" title="Close" onClick={onClose}>×</Button>
    </div>
  )
}
