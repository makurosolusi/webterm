// Port sesi runtime worker P3: bentuk sempit yang dibutuhkan `createWorkerRuntime` plus
// adapter dari `Sessions` asli. Modul ini sengaja tanpa import runtime supaya test bebas PTY.
import type { OpenMsg, ServerMsg } from '../../shared/protocol'
import type { AgentStatus } from '../../shared/workspace'

/** Port sesi yang dibutuhkan runtime; `sessions` asli memenuhi bentuk ini lewat adapter. */
export interface WorkerSessionPort {
  open(input: {
    nodeId: string
    cwd: string
    cmd?: string
    agentId?: string
    cols?: number
    rows?: number
  }): void | Promise<void>
  input(nodeId: string, text: string): void
  statusOf(nodeId: string): AgentStatus | undefined
  getTerminal(nodeId: string): string
  isLive(nodeId: string): boolean
  close(nodeId: string): void
}

/** Subset struktural `Sessions`; sengaja tanpa import runtime supaya test bebas PTY. */
export interface SessionsLike {
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void
  input(id: string, data: string): void
  statusOf(id: string): AgentStatus | undefined
  getTerminal(id: string): string
  isLive(id: string): boolean
  close(id: string): void
}

export function createSessionsPort(source: SessionsLike): WorkerSessionPort {
  const noop = (): void => {}
  return {
    open: (input) =>
      source.open(
        {
          t: 'open',
          id: input.nodeId,
          cols: input.cols ?? 120,
          rows: input.rows ?? 40,
          cwd: input.cwd,
          ...(input.cmd ? { cmd: input.cmd } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        },
        noop
      ),
    input: (nodeId, text) => source.input(nodeId, text),
    statusOf: (nodeId) => source.statusOf(nodeId),
    getTerminal: (nodeId) => source.getTerminal(nodeId),
    isLive: (nodeId) => source.isLive(nodeId),
    close: (nodeId) => source.close(nodeId),
  }
}
