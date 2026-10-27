import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import { spawnPty, type Pty } from './pty'

interface Session {
  id: string
  pty: Pty
  buffer: string[]
  bytes: number
  send?: (m: ServerMsg) => void
}

// Scrollback kept per session so a re-attaching socket can replay what it missed.
const SCROLLBACK_BYTES = 256 * 1024

export class Sessions {
  private map = new Map<string, Session>()

  open(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    const existing = this.map.get(msg.id)
    if (existing) {
      // PTY survived the previous socket — re-attach and replay scrollback.
      existing.send = send
      for (const chunk of existing.buffer) send({ t: 'output', id: msg.id, data: chunk })
      return
    }

    const pty = spawnPty({ cols: msg.cols, rows: msg.rows, cwd: msg.cwd })
    const session: Session = { id: msg.id, pty, buffer: [], bytes: 0, send }
    this.map.set(msg.id, session)

    pty.onData((data) => {
      session.buffer.push(data)
      session.bytes += data.length
      while (session.bytes > SCROLLBACK_BYTES && session.buffer.length > 1) {
        session.bytes -= session.buffer.shift()!.length
      }
      session.send?.({ t: 'output', id: session.id, data })
    })
    pty.onExit((code) => {
      session.send?.({ t: 'exit', id: session.id, code })
      this.map.delete(session.id)
    })
  }

  input(id: string, data: string): void {
    this.map.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.map.get(id)?.pty.resize(cols, rows)
  }

  close(id: string): void {
    const session = this.map.get(id)
    if (!session) return
    session.pty.kill()
    this.map.delete(id)
  }

  // Socket gone: forget the subscriber but keep the PTY running so a reconnect
  // with the same id re-attaches instead of spawning a fresh shell.
  detach(send: (m: ServerMsg) => void): void {
    for (const session of this.map.values()) {
      if (session.send === send) session.send = undefined
    }
  }

  handle(msg: ClientMsg, send: (m: ServerMsg) => void): void {
    switch (msg.t) {
      case 'open': this.open(msg, send); break
      case 'input': this.input(msg.id, msg.data); break
      case 'resize': this.resize(msg.id, msg.cols, msg.rows); break
      case 'close': this.close(msg.id); break
    }
  }
}

export const sessions = new Sessions()
