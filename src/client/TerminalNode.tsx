import { useEffect, useRef } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { subscribe, send } from './ws'

export default function TerminalNode({ data }: NodeProps) {
  const id = (data as { id: string }).id
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
    send({ t: 'open', id, cols: term.cols, rows: term.rows })

    // Refit on container resize and tell the server the new dimensions.
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
  }, [id])

  return (
    <div style={{ width: 480, height: 320, background: '#1e1e1e', borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
      <div style={{ height: 24, background: '#2a2a2a', color: '#888', fontSize: 11, lineHeight: '24px', padding: '0 8px', fontFamily: 'monospace', cursor: 'grab' }}>
        {id.slice(0, 8)}
      </div>
      {/* nodrag: let the user select text in the terminal without dragging the node */}
      <div ref={ref} className="nodrag" style={{ height: 'calc(100% - 24px)', width: '100%' }} />
    </div>
  )
}
