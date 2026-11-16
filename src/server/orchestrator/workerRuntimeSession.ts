// Port sesi runtime worker P3: bentuk sempit yang dibutuhkan `createWorkerRuntime` plus
// adapter dari `Sessions` asli. Modul ini sengaja tanpa import runtime supaya test bebas PTY.
import type { OpenMsg, ServerMsg } from '../../shared/protocol'
import type { ModelPick } from '../models/modelLadder'
import type { AgentStatus } from '../../shared/workspace'
import { submitToNode, type SubmitOptions, type SubmitResult, type SubmitSessions } from '../agentSubmit'

/** Port sesi yang dibutuhkan runtime; `sessions` asli memenuhi bentuk ini lewat adapter. */
export interface WorkerSessionPort {
  open(input: {
    nodeId: string
    cwd: string
    cmd?: string
    agentId?: string
    /** Id sesi baru per run; `launchLine` yang memvalidasi + menggerbangi flag-nya. */
    sessionId?: string
    /** Relaunch the saved conversation of `sessionId` (`--resume`) instead of minting it. */
    resume?: boolean
    cols?: number
    rows?: number
    /** The ladder's model pick; already applied to `cmd` by the host, carried for the session record. */
    pick?: ModelPick | null
  }): void | Promise<void>
  input(nodeId: string, text: string): void
  /** Types and submits a prompt, confirmed on screen for Claude (`agentSubmit.ts`). */
  submit(nodeId: string, text: string, options?: SubmitOptions): Promise<SubmitResult>
  statusOf(nodeId: string): AgentStatus | undefined
  getTerminal(nodeId: string): string
  isLive(nodeId: string): boolean
  close(nodeId: string): void
}

/** Subset struktural `Sessions`; sengaja tanpa import runtime supaya test bebas PTY. */
export interface SessionsLike extends SubmitSessions {
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void
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
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.resume ? { resume: true } : {}),
        },
        noop
      ),
    input: (nodeId, text) => source.input(nodeId, text),
    submit: (nodeId, text, options) => submitToNode(source, nodeId, text, options),
    statusOf: (nodeId) => source.statusOf(nodeId),
    getTerminal: (nodeId) => source.getTerminal(nodeId),
    isLive: (nodeId) => source.isLive(nodeId),
    close: (nodeId) => source.close(nodeId),
  }
}
