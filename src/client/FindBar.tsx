import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Textfield, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import './findBar.css'

/**
 * Find bar mengambang di dalam node; meneruskan istilah ke handle search `TerminalCore`.
 *
 * Find widget VS Code: `vscode-textfield` + `vscode-toolbar-container` (aksi 22px, ikon codicon
 * panah atas/bawah/close), kiri-atas-ke-kanan di pojok kanan atas node. Enter / Shift+Enter / Esc
 * sama seperti VS Code. Toggle Aa/ab/.* dan hitungan "1 of 3" belum ada: butuh opsi + hasil dari
 * `TerminalCore`, yang bukan bagian bar ini. `value` milik host
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
    <div className="nodrag node-find findbar" role="search" aria-label="Find">
      <Textfield
        ref={(node) => { fieldRef.current = node }}
        value={term} placeholder="Find" aria-label="Find" className="node-find__field"
        onInput={(e) => setTerm((e.target as unknown as { value: string }).value)}
        onKeyDown={onKey}
      />
      <ToolbarContainer className="node-find__actions">
        <ToolbarButton label="Previous Match" title="Previous Match (Shift+Enter)" data-title="Previous Match (Shift+Enter)" onClick={() => onSearch(term, 'prev')}><span className="codicon codicon-arrow-up" aria-hidden="true" /></ToolbarButton>
        <ToolbarButton label="Next Match" title="Next Match (Enter)" data-title="Next Match (Enter)" onClick={() => onSearch(term, 'next')}><span className="codicon codicon-arrow-down" aria-hidden="true" /></ToolbarButton>
        <ToolbarButton label="Close" title="Close (Escape)" data-title="Close (Escape)" onClick={onClose}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
      </ToolbarContainer>
    </div>
  )
}
