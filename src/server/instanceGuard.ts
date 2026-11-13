// One server per data dir, enforced by the server itself (the reverse of src/native/nativeSession.ts, where
// the app attaches instead of starting a second one): a server refuses to start while <dataDir>/run/server.json
// names another process that is alive and answering on its recorded host:port. Two servers on the same SQLite
// files fight over the workspaces, the ledger and the run dir. A stale record (dead pid, or nothing answers
// within INSTANCE_ANSWER_TIMEOUT_MS) is ignored; the new server overwrites it once it is listening.
//
// ponytail: check-then-start, not a lock. The record is written only after listen(), so two servers starting
// within that window (boot up to the bind, ~1-2 s) both see no record and both start; the later record wins.
// Covers every sequential case (the second start of a dev server, the binary, the app). Upgrade path: an
// O_EXCL lock file in the run dir taken before the DBs open, if two simultaneous starts ever matter.
import { join } from 'node:path'
import { HEALTH_PATH } from '../shared/protocol'
import { INSTANCE_ANSWER_TIMEOUT_MS, isProcessAlive, readInstanceFile } from './instanceFile'
import { RUN_SUBDIR, openOrigin } from './uiOpen'

/** Exit code of a server that refused to start because another one serves its data dir. */
export const ALREADY_RUNNING_EXIT_CODE = 1

/** Another live server already serves this data dir; the message is the one line the CLI prints. */
export class AlreadyRunningError extends Error {
  override name = 'AlreadyRunningError'
  constructor(readonly dataDir: string, readonly origin: string, readonly pid: number) {
    super(`webterm is already running for ${dataDir} on ${origin} (pid ${pid}). Open that one, or set WEBTERM_DATA_DIR to run another.`)
  }
}

/** Any HTTP status from `origin` counts (the health route sits behind the auth gate); none in time = not answering. */
async function answers(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}${HEALTH_PATH}`, { redirect: 'manual', signal: AbortSignal.timeout(INSTANCE_ANSWER_TIMEOUT_MS) })
    await res.body?.cancel()
    return true
  } catch (err) {
    // Refused, reset or timed out: nothing serves that port any more. Same rule as nativeSession.ts signInFileFrom.
    console.info(`[webterm] recorded server on ${origin} does not answer (${err instanceof Error ? err.message : String(err)}): stale record`)
    return false
  }
}

/** Throws AlreadyRunningError when `dataDir`'s record names a process other than `ownPid` that is alive and answering. */
export async function assertSoleServer(dataDir: string, ownPid: number = process.pid): Promise<void> {
  const rec = readInstanceFile(join(dataDir, RUN_SUBDIR))
  if (rec === null || rec.pid === ownPid || !isProcessAlive(rec.pid)) return
  const origin = openOrigin(rec.host, rec.port)
  if (await answers(origin)) throw new AlreadyRunningError(dataDir, origin, rec.pid)
}
