// sec-208-5 lock: both content-read verbs refuse anything that is not a regular file, judged on the
// OPENED handle. The size cap used to be checked against `stat().size`, which is 0 for pipes and
// character devices, so `/dev/zero` grew the server without bound, a fed FIFO bypassed the 24 MiB cap,
// and a FIFO with no writer hung the request (and leaked an fd) forever.
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FS_READ_BINARY_MAX_BYTES } from '../shared/fsLimits'
import { readBinary, readErrorResult, readTextMeta } from './fsOps'

const root = mkdtempSync(join(tmpdir(), 'webterm-fsspecial-'))
const writers: ChildProcess[] = []
/** Hard lifetime of every FIFO writer, enforced inside its own shell so it holds even if this process dies. */
const WRITER_MAX_LIFETIME_S = 30

/** Spawn `cmd` (a FIFO writer that may block forever on open) under an in-shell SIGKILL watchdog. */
function writer(cmd: string): void {
  // ponytail: the watchdog kills `$$` by PID after the bound even if cmd already exited; PID reuse
  // within 30s is the ceiling. `exec` makes `$$` the writer itself, so afterAll's kill hits it directly.
  const script = `(sleep ${WRITER_MAX_LIFETIME_S}; kill -9 $$ 2>/dev/null) & exec ${cmd}`
  writers.push(spawn('sh', ['-c', script], { stdio: 'ignore' }))
}
afterAll(() => {
  for (const w of writers) w.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

const READERS = { readBinary, readTextMeta } as const
const TIMEOUT = 'TIMEOUT'

/** Outcome of one read within 1s: the HTTP status it maps to, 'read' if it succeeded, or TIMEOUT. */
async function outcome(read: () => Promise<unknown>): Promise<number | 'read' | typeof TIMEOUT> {
  const settled = read().then(() => 'read' as const, (err: unknown) => readErrorResult(err).status)
  return Promise.race([settled, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), 1000))])
}

function fifo(name: string): string {
  const p = join(root, name)
  execFileSync('mkfifo', [p])
  return p
}

describe('content reads refuse non-regular files within 1s (sec-208-5)', () => {
  for (const [verb, read] of Object.entries(READERS)) {
    test(`${verb}: a FIFO with no writer -> 400, no hang`, async () => {
      const p = fifo(`idle-${verb}.png`)
      const got = await outcome(() => read(p))
      // On a regression the pending open() would keep the process alive; give it its writer.
      if (got === TIMEOUT) writer(`true > "${p}"`)
      expect(got).toBe(400)
    })

    test(`${verb}: a FIFO fed past the binary cap -> 400, the cap cannot be bypassed`, async () => {
      const p = fifo(`fed-${verb}.bin`)
      writer(`head -c ${FS_READ_BINARY_MAX_BYTES + 8 * 1024 * 1024} /dev/zero > "${p}"`)
      expect(await outcome(() => read(p))).toBe(400)
    })

    test(`${verb}: /dev/zero -> 400, no unbounded read`, async () => {
      expect(await outcome(() => read('/dev/zero'))).toBe(400)
    })
  }
})
