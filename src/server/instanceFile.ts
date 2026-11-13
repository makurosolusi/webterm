// `<dataDir>/run/server.json`: which process serves this data dir and on which port, so the native app
// (src/native/nativeSession.ts) attaches to a running server instead of starting a second one on the
// same SQLite files. Written once the listener is bound, removed on a clean stop; a crash leaves it
// behind, so a reader must prove the process is alive and answering (stale file = ignore).
// Lives in the run dir: 0700, and listed in agentSandbox AGENT_SECRET_ENTRIES.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INSTANCE_FILE = 'server.json'
const RUN_DIR_MODE = 0o700
const FILE_MODE = 0o600

/** What a server records about itself. `host` is the bind host (may be a wildcard). */
export interface InstanceRecord { pid: number; host: string; port: number }

const isRecord = (v: unknown): v is InstanceRecord => {
  const r = v as Partial<InstanceRecord> | null
  return typeof r === 'object' && r !== null && Number.isInteger(r.pid) && typeof r.host === 'string' && Number.isInteger(r.port)
}

/** Atomically record this server in `runDir` (tmp file + rename: a reader never sees half a file). */
export function writeInstanceFile(runDir: string, rec: InstanceRecord): void {
  mkdirSync(runDir, { recursive: true, mode: RUN_DIR_MODE })
  if (lstatSync(runDir).isSymbolicLink()) throw new Error(`refusing to write ${INSTANCE_FILE}: ${runDir} is a symlink`)
  const tmp = join(runDir, `${INSTANCE_FILE}.${rec.pid}.tmp`)
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(rec), { mode: FILE_MODE, flag: 'wx' })
  renameSync(tmp, join(runDir, INSTANCE_FILE))
}

/** The recorded server, or null when there is none or the file is not a record (treated as absent). */
export function readInstanceFile(runDir: string): InstanceRecord | null {
  let raw: string
  try {
    raw = readFileSync(join(runDir, INSTANCE_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read ${INSTANCE_FILE} in ${runDir}`, { cause: err })
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch (err) {
    if (err instanceof SyntaxError) return null // torn/foreign content: the next server overwrites it
    throw err
  }
}

/** Remove the record only if it is still `pid`'s: a newer server that took over keeps its own. */
export function removeInstanceFile(runDir: string, pid: number): void {
  if (readInstanceFile(runDir)?.pid === pid) rmSync(join(runDir, INSTANCE_FILE), { force: true })
}
