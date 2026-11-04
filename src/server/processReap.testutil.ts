// Test-only: end a bun test file with ZERO live child processes.
//
// Why (root cause of the intermittent `npm run test:bun` hangs): when a file ends while a child it
// spawned is still alive, `bun test` kills it itself ("killed N dangling processes") and then waits
// for it SYNCHRONOUSLY, with the event loop stopped. A PTY child (shell, tmux client) that is
// exiting with output still queued on its tty cannot finish its exit until that output is read from
// the PTY master, and only our event loop reads the master. Child waits for Bun, Bun waits for the
// child: the process freezes between two files, where no per-test or hook timeout can fire (seen as
// state `E` children plus `<defunct>` siblings that Bun never reaps).
// Reaping here, inside an async `afterAll`, keeps the loop running so masters drain and Bun reaps.
import { execFileSync } from 'node:child_process'

const POLL_MS = 50
const TERM_GRACE_MS = 1_000
/** Under bun's default 5 s hook timeout, so the error below (not the generic timeout) reports a stuck child. */
export const REAP_BUDGET_MS = 4_000

interface Child { pid: number; stat: string; comm: string }

/** Direct children of this process (the `ps` doing the listing excluded). */
function children(): Child[] {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
  const kids: Child[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m || Number(m[2]) !== process.pid) continue
    const comm = (m[4] ?? '').trim()
    if (comm === 'ps' || comm.endsWith('/ps')) continue
    kids.push({ pid: Number(m[1]), stat: m[3] ?? '', comm })
  }
  return kids
}

function signal(pids: number[], sig: 'SIGTERM' | 'SIGKILL'): void {
  for (const pid of pids) {
    try { process.kill(pid, sig) } catch { /* already gone between `ps` and here: that is the goal */ }
  }
}

/**
 * SIGTERM, then SIGKILL, every direct child, and poll (async: the event loop keeps draining PTY
 * masters and reaping zombies) until none is left. Throws, naming pid/state/command, when the
 * budget runs out, so a stuck child fails this file's hook instead of freezing the whole run.
 */
export async function reapChildren(budgetMs = REAP_BUDGET_MS): Promise<void> {
  const start = Date.now()
  let left = children()
  if (left.length === 0) return
  signal(left.map((c) => c.pid), 'SIGTERM')
  let killed = false
  while (left.length > 0) {
    const elapsed = Date.now() - start
    if (elapsed > budgetMs) {
      throw new Error(`reapChildren: ${left.length} child process(es) still alive after ${budgetMs} ms: ${left.map((c) => `${c.pid}[${c.stat}] ${c.comm}`).join(', ')}`)
    }
    if (!killed && elapsed > TERM_GRACE_MS) { signal(left.map((c) => c.pid), 'SIGKILL'); killed = true }
    await new Promise((r) => setTimeout(r, POLL_MS))
    left = children()
  }
}
