// Tunggu sesi worker sampai settle (done/timeout/lease/exit). Jam dan tidur di-inject supaya
// test deterministik tanpa timer nyata; batas poll mencegah loop abadi saat jam tidak maju.
import type { WorkerSessionPort } from './workerRuntimeSession'

export type Settle = 'done' | 'timeout' | 'lease_expired' | 'session_exited'

export interface WaitLimits {
  deadline: number
  leaseDeadline: number | null
  timeoutMs: number
  pollMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** Poll status sampai done/exit; jam dan tidur di-inject supaya test deterministik. */
export async function waitForSettle(
  sessions: WorkerSessionPort,
  nodeId: string,
  limits: WaitLimits
): Promise<Settle> {
  const maxPolls = Math.max(1, Math.ceil(limits.timeoutMs / limits.pollMs) + 2)
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (sessions.statusOf(nodeId) === 'done') return 'done'
    if (!sessions.isLive(nodeId)) return 'session_exited'
    const at = limits.now()
    if (limits.leaseDeadline !== null && at >= limits.leaseDeadline) return 'lease_expired'
    if (at >= limits.deadline) return 'timeout'
    await limits.sleep(limits.pollMs)
  }
  // Jam yang tidak maju tidak boleh membuat loop abadi: batas poll = batas waktu.
  return 'timeout'
}
