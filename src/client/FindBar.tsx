import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

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
    <div className="nodrag" style={{
      position: 'absolute', top: 6, right: 6, zIndex: 20, display: 'flex', gap: 4, alignItems: 'center',
      padding: 4, borderRadius: 8, background: 'var(--surface-raised, #1c1c1e)', border: '1px solid var(--border, #38383a)',
    }}>
      <Input className={cn('field')} autoFocus value={term} placeholder="Find…"
        onChange={(e) => setTerm(e.target.value)} onKeyDown={onKey} style={{ width: 140 }} />
      <Button variant="ghost" size="icon-xs" className="icon-btn" title="Previous" onClick={() => onSearch(term, 'prev')}>‹</Button>
      <Button variant="ghost" size="icon-xs" className="icon-btn" title="Next" onClick={() => onSearch(term, 'next')}>›</Button>
      <Button variant="ghost" size="icon-xs" className="icon-btn" title="Close" onClick={onClose}>×</Button>
    </div>
  )
}
