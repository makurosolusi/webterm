import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { subscribe, send } from './ws'
import type { AgentId } from '../shared/workspace'

// The reusable xterm body: mounts a terminal, subscribes to its PTY, and sends
// the initial `open` (with optional cwd/cmd). Does NOT send `close` on cleanup —
// App owns close on node removal, so switching workspaces keeps the PTY alive.
export default function TerminalCore({ id, cmd, cwd, agentId, sessionId, resume }: {
  id: string; cmd?: string; cwd?: string; agentId?: AgentId; sessionId?: string; resume?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: '#1e1e1e', foreground: '#e0e0e0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

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
    }
  }, [id, cmd, cwd, agentId, sessionId, resume])

  return <div ref={ref} className="nodrag" style={{ height: '100%', width: '100%' }} />
}
