// Sinyal `candidate_done` untuk worker PTY non-claude (RND/22 §4.3): agent tanpa hook status
// tidak pernah melapor `done`, jadi sesi yang diam >= WEBTERM_AGENT_IDLE_DONE_MS DAN worktree-nya
// berubah dianggap kandidat selesai. Ini hanya membuka jalan ke verifier server; idle saja
// bukan bukti, dan hasil akhir tetap ditentukan verifier.
import { createLogger } from '../logs'
import type { WorkerSessionPort } from './workerRuntimeSession'

const log = createLogger('orchestrator')

/** Sama dengan default registry `WEBTERM_AGENT_IDLE_DONE_MS`. */
export const DEFAULT_IDLE_DONE_MS = 45_000
export const MIN_IDLE_DONE_MS = 1_000
export const MAX_IDLE_DONE_MS = 3_600_000
const TAIL_CHARS = 256

/** Ambang idle dari env; di luar rentang atau bukan angka jatuh ke default. */
export function idleDoneMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['WEBTERM_AGENT_IDLE_DONE_MS'])
  return Number.isFinite(raw) && raw >= MIN_IDLE_DONE_MS && raw <= MAX_IDLE_DONE_MS ? Math.round(raw) : DEFAULT_IDLE_DONE_MS
}

/** Kandidat selesai hanya bila diam cukup lama DAN ada perubahan di worktree. */
export function candidateDone(input: { idleMs: number; thresholdMs: number; hasDiff: boolean }): boolean {
  return input.hasDiff && input.idleMs >= input.thresholdMs
}

/** `git` di dalam `cwd` tanpa shell; implementasi produksi memakai `createProcessExec`. */
export type GitProbe = (cwd: string, args: string[]) => Promise<{ code: number; stdout?: string }>

export interface CandidateSignalOptions {
  thresholdMs: number
  probe: GitProbe
  now?: () => number
}

interface NodeWatch {
  cwd: string
  head0: string | null
  signature: string
  changedAt: number
  diff: boolean
  probing: boolean
}

async function gitOut(probe: GitProbe, cwd: string, args: string[]): Promise<string | null> {
  const result = await probe(cwd, args)
  return result.code === 0 ? (result.stdout ?? '').trim() : null
}

/** Ada perubahan bila `status` tidak bersih atau HEAD pindah dari saat sesi dibuka (commit lokal). */
async function worktreeChanged(probe: GitProbe, watch: NodeWatch): Promise<boolean> {
  const dirty = await gitOut(probe, watch.cwd, ['status', '--porcelain'])
  if (dirty !== null && dirty !== '') return true
  if (watch.head0 === null) return false
  const head = await gitOut(probe, watch.cwd, ['rev-parse', 'HEAD'])
  return head !== null && head !== watch.head0
}

/**
 * Membungkus port sesi: `statusOf` mengembalikan `done` juga saat `candidateDone` terpenuhi.
 * Diff dihitung async (cache) supaya poll runtime tidak memblokir; baru diprobe setelah idle.
 */
export function withCandidateSignal(inner: WorkerSessionPort, options: CandidateSignalOptions): WorkerSessionPort {
  const now = options.now ?? (() => Date.now())
  const watches = new Map<string, NodeWatch>()

  const refresh = (nodeId: string, watch: NodeWatch): void => {
    if (watch.probing) return
    watch.probing = true
    worktreeChanged(options.probe, watch)
      .then((changed) => {
        watch.diff = changed
      })
      .catch(() => {
        // Probe gagal = belum ada bukti diff; sinyal tidak menyala. Hanya kode yang di-log (pesan bisa memuat path).
        log.warn('orchestrator.worker.signal', 'candidate diff probe failed', { code: 'probe_failed', ids: { nodeId } })
      })
      .finally(() => {
        watch.probing = false
      })
  }

  return {
    ...inner,
    async open(input) {
      await inner.open(input)
      const watch: NodeWatch = { cwd: input.cwd, head0: null, signature: '', changedAt: now(), diff: false, probing: false }
      watches.set(input.nodeId, watch)
      // HEAD awal tak terbaca = hanya `status` yang dipakai; bukan kegagalan yang perlu dihentikan.
      watch.head0 = await gitOut(options.probe, input.cwd, ['rev-parse', 'HEAD']).catch(() => null)
    },
    statusOf(nodeId) {
      const status = inner.statusOf(nodeId)
      const watch = watches.get(nodeId)
      if (status === 'done' || watch === undefined) return status
      const output = inner.getTerminal(nodeId)
      const signature = `${output.length}:${output.slice(-TAIL_CHARS)}`
      if (signature !== watch.signature) {
        watch.signature = signature
        watch.changedAt = now()
        watch.diff = false
        return status
      }
      const idleMs = now() - watch.changedAt
      if (idleMs < options.thresholdMs) return status
      if (candidateDone({ idleMs, thresholdMs: options.thresholdMs, hasDiff: watch.diff })) return 'done'
      refresh(nodeId, watch)
      return status
    },
    close(nodeId) {
      watches.delete(nodeId)
      inner.close(nodeId)
    },
  }
}
