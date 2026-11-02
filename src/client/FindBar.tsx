import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Textfield, ToolbarButton, ToolbarContainer } from '@/vscode/register'

/**
 * Find bar mengambang di dalam node; meneruskan istilah ke handle search `TerminalCore`.
 *
 * Memakai `vscode-textfield` + `vscode-toolbar-container` (22px actions). `value` milik host
 * diterapkan lewat properti lit di browser, sedangkan `input`/keydown adalah event yang
 * diteruskan ke host — jadi state React tetap satu-satunya sumber istilah.
 */
export default function FindBar({ onSearch, onClose }: {
  onSearch: (term: string, direction: 'next' | 'prev') => void
  onClose: () => void
}) {
  const [term, setTerm] = useState('')
  const fieldRef = useRef<HTMLElement | null>(null)

  useEffect(() => { fieldRef.current?.focus() }, [])

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); onSearch(term, e.shiftKey ? 'prev' : 'next') }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  return (
    <div className="nodrag node-find absolute top-1.5 right-1.5 z-20 flex items-center gap-1 rounded-lg border border-border bg-[rgb(var(--card-rgb))] p-1">
      <Textfield
        ref={(node) => { fieldRef.current = node }}
        value={term} placeholder="Find…" className="node-find__field"
        onInput={(e) => setTerm((e.target as unknown as { value: string }).value)}
        onKeyDown={onKey}
      />
      <ToolbarContainer className="node-find__actions">
        <ToolbarButton label="Previous" title="Previous" onClick={() => onSearch(term, 'prev')}>‹</ToolbarButton>
        <ToolbarButton label="Next" title="Next" onClick={() => onSearch(term, 'next')}>›</ToolbarButton>
        <ToolbarButton label="Close" title="Close" onClick={onClose}>×</ToolbarButton>
      </ToolbarContainer>
    </div>
  )
}
