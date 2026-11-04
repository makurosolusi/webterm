// Kejadian log sesi PTY/agent. Dipisah dari `sessions*.ts` supaya jalur panas tidak membengkak dan
// supaya aturan "apa yang boleh dicatat" ada di satu tempat: id, pid, basename, angka — TIDAK
// pernah byte terminal, baris perintah, env, atau cwd penuh.
import { basename } from 'node:path'
import type { OpenMsg } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'
import { createLogger } from './logs'

const pty = createLogger('pty')
const agent = createLogger('agent')

/** Nama shell untuk log: basename saja, karena path-nya memuat nama pengguna. */
const shellName = (shell?: string): string => basename(shell || process.env.SHELL || 'default-shell')

export const ptyLog = {
  /** Sesi baru di-spawn (`agent.spawn` ikut dicatat bila node ini agent). pid -1 = spawn gagal. */
  spawned(msg: OpenMsg, pid: number, shell?: string): void {
    const ids = { nodeId: msg.id }
    pty.info('pty.spawn', pid < 0 ? 'Shell failed to start' : 'Spawned shell', {
      ids, pid, shell: shellName(shell), cols: msg.cols, rows: msg.rows,
      cwd: msg.cwd ? basename(msg.cwd) : undefined, resume: msg.resume === true,
    })
    if (msg.agentId) agent.info('agent.spawn', 'Agent session started', { ids, agentId: msg.agentId, resume: msg.resume === true })
  },
  /** Socket baru menempel ke sesi yang sudah hidup (tanpa spawn). */
  reattached(nodeId: string, subscribers: number): void {
    pty.debug('pty.attach', 'Re-attached to live session', { ids: { nodeId }, subscribers })
  },
  resized(nodeId: string, cols: number, rows: number): void {
    pty.trace('pty.resize', 'Resize requested', { ids: { nodeId }, cols, rows })
  },
  /** PTY keluar sendiri (`self`) atau diminta tutup (`closed`). */
  exited(nodeId: string, agentId: string | undefined, code: number, reason: 'self' | 'closed', durationMs: number): void {
    const ids = { nodeId }
    pty.info('pty.exit', reason === 'self' ? 'Shell exited' : 'Shell closed by request', { ids, code, reason, durationMs })
    if (agentId) agent.info('agent.exit', 'Agent session ended', { ids, agentId, code, reason, durationMs })
  },
  status(nodeId: string, from: AgentStatus | undefined, to: AgentStatus): void {
    agent.info('agent.status', `Status ${from ?? 'none'} -> ${to}`, { ids: { nodeId }, from, to })
  },
  statusCleared(nodeId: string): void {
    agent.debug('agent.status.stale', 'Stale working status cleared', { ids: { nodeId } })
  },
  /** Boot menempel ulang sesi tmux yang selamat dari server sebelumnya. */
  adopted(adopted: number, orphans: number): void {
    pty.info('pty.adopt', 'Re-adopted supervised sessions', { adopted, orphans })
    if (orphans) pty.warn('pty.orphan', 'Supervised sessions without a workspace node marked orphan', { orphans })
  },
  /** Hanya nama galat: pesannya bisa memuat path data dir pengguna. */
  adoptKnownFailed(err: unknown): void {
    pty.warn('pty.adopt_known_failed', 'Workspace node list unavailable; adopting every session', { error: err instanceof Error ? err.name : 'unknown' })
  },
  adoptFailed(err: unknown): void {
    pty.error('pty.adopt_failed', 'Re-adopting supervised sessions failed', { error: err instanceof Error ? err.name : 'unknown' })
  },
}
