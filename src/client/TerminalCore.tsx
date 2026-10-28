import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { subscribe, send } from './ws'
import type { AgentId } from '../shared/workspace'

export interface TerminalHandle {
  search(term: string, opts?: { direction?: 'next' | 'prev' }): void
  clearSearch(): void
  refit(): void
}

interface Props {
  id: string; cmd?: string; cwd?: string; agentId?: AgentId; sessionId?: string; resume?: boolean
}

// The reusable xterm body: mounts a terminal, subscribes to its PTY, and sends
// the initial `open` (with optional cwd/cmd). Does NOT send `close` on cleanup —
// App owns close on node removal, so switching workspaces keeps the PTY alive.
// Exposes search/refit imperatively so node chrome can drive it without remount.
const TerminalCore = forwardRef<TerminalHandle, Props>(function TerminalCore(
  { id, cmd, cwd, agentId, sessionId, resume }, ref,
) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)

  useImperativeHandle(ref, () => ({
    search(term, opts) {
      const s = searchRef.current
      if (!s || !term) return
      if (opts?.direction === 'prev') s.findPrevious(term)
      else s.findNext(term)
    },
    clearSearch() {
      searchRef.current?.clearDecorations?.()
      termRef.current?.clearSelection()
    },
    refit() {
      const term = termRef.current, fit = fitRef.current
      if (!term || !fit) return
      fit.fit()
      term.refresh(0, term.rows - 1)
      send({ t: 'resize', id, cols: term.cols, rows: term.rows })
    },
  }), [id])

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: '#1e1e1e', foreground: '#e0e0e0' },
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(el)
    fit.fit()
    termRef.current = term; fitRef.current = fit; searchRef.current = search

    const unsub = subscribe(
      id,
      (d) => term.write(d),
      () => term.write('\r\n[process exited]')
    )
    term.onData((d) => send({ t: 'input', id, data: d }))
    // Initial open after fit so the server spawns the PTY at the right size.
    send({ t: 'open', id, cols: term.cols, rows: term.rows,
      ...(cwd ? { cwd } : {}), ...(cmd ? { cmd } : {}),
      ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}), ...(resume ? { resume: true } : {}) })

    const ro = new ResizeObserver(() => {
      fit.fit()
      send({ t: 'resize', id, cols: term.cols, rows: term.rows })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      unsub()
      term.dispose()
      termRef.current = null; fitRef.current = null; searchRef.current = null
    }
  }, [id, cmd, cwd, agentId, sessionId, resume])

  return <div ref={elRef} className="nodrag" style={{ height: '100%', width: '100%' }} />
})

export default TerminalCore
