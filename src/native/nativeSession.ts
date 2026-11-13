// One webterm server per data dir, like VS Code's single instance: the native app attaches its window
// to a server already running for WEBTERM_DATA_DIR (a dev server, the CLI binary, another app) and only
// starts one in-process when there is none. Plain Bun/Node, no Electrobun import (testable headless).
//
// Discovery: <dataDir>/run/server.json (server/instanceFile.ts) names pid + port. Stale when the pid is
// dead or nothing answers there; then this process starts its own server, which overwrites the record.
// Sign-in when attaching: POST /auth/request-open { launch: false } makes the running server mint a
// one-time code into its 0600 redirect file under the same 0700 run dir; the window loads that FILE.
// The code never crosses HTTP: only a process that can read this data dir (its owner, who can already
// read the token and the DB) can use it. The file existing under the recorded pid's name also proves the
// server that answered is the one serving this data dir.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../server/config'
import { INSTANCE_ANSWER_TIMEOUT_MS, type InstanceRecord, isProcessAlive, readInstanceFile } from '../server/instanceFile'
import { RUN_SUBDIR, openOrigin, signInFileName } from '../server/uiOpen'
import { freeLoopbackPort, startEmbeddedServer } from './embeddedServer'

/** Longest Retry-After honoured once when another window was just requested (OPEN_INTERVAL_MS in auth.routes.ts). */
const MAX_RETRY_WAIT_MS = 10_000
const HTTP_ACCEPTED = 202
const HTTP_TOO_MANY = 429
const MS_PER_S = 1_000

/** A live server for this data dir answered but would not open a window (the app must not start a second one). */
export class AttachRefusedError extends Error {
  override name = 'AttachRefusedError'
}

export interface NativeSession {
  /** `attached`: a server for this data dir was already running; `embedded`: started in this process. */
  mode: 'attached' | 'embedded'
  /** Origin the window talks to. */
  origin: string
  /** Before the app quits: stops the in-process server; leaves an attached (external) server running. */
  quit(): Promise<void>
}

const requestSignInFile = (origin: string): Promise<Response> => fetch(`${origin}/auth/request-open`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ launch: false }),
  signal: AbortSignal.timeout(INSTANCE_ANSWER_TIMEOUT_MS),
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Ask the recorded server for a sign-in file: the path, or null when the record is stale. Throws when a live
 *  server for this data dir refuses (starting a second one on the same SQLite files would be worse). */
async function signInFileFrom(runDir: string, rec: InstanceRecord): Promise<{ origin: string; signInFile: string } | null> {
  const origin = openOrigin(rec.host, rec.port)
  let res: Response
  try {
    res = await requestSignInFile(origin)
    if (res.status === HTTP_TOO_MANY) {
      await sleep(Math.min(Number(res.headers.get('retry-after') ?? 0) * MS_PER_S, MAX_RETRY_WAIT_MS))
      res = await requestSignInFile(origin)
    }
  } catch (err) {
    console.info(`[webterm] recorded server pid ${rec.pid} does not answer on ${origin} (${err instanceof Error ? err.message : String(err)}): stale record`)
    return null
  }
  if (res.status !== HTTP_ACCEPTED) throw new AttachRefusedError(`webterm server pid ${rec.pid} on ${origin} refused a sign-in window (HTTP ${res.status})`)
  const signInFile = join(runDir, signInFileName(rec.pid))
  if (!existsSync(signInFile)) {
    console.info(`[webterm] the server on ${origin} is not pid ${rec.pid} of this data dir: stale record`)
    return null
  }
  return { origin, signInFile }
}

/** The server already running for `runDir`'s data dir with a fresh sign-in file, or null (none / stale). */
export async function findRunningServer(runDir: string): Promise<{ origin: string; signInFile: string } | null> {
  const rec = readInstanceFile(runDir)
  if (rec === null) return null
  if (!isProcessAlive(rec.pid)) {
    console.info(`[webterm] recorded server pid ${rec.pid} is not running: stale record`)
    return null
  }
  return signInFileFrom(runDir, rec)
}

/** Attach to the data dir's running server, else start one in-process; `showSignInFile` gets the path of the
 *  0600 redirect file to load in the window (a path, never the code-bearing URL). */
export async function openNativeSession(o: { showSignInFile: (path: string) => void | Promise<void>; distDir?: string; selfEntry?: string }): Promise<NativeSession> {
  const running = await findRunningServer(join(dataDir(), RUN_SUBDIR))
  if (running) {
    console.info(`[webterm] attaching to the running server at ${running.origin}`)
    await o.showSignInFile(running.signInFile)
    return { mode: 'attached', origin: running.origin, quit: async () => {} } // not ours to stop
  }
  const server = await startEmbeddedServer({ port: await freeLoopbackPort(), openFile: async (p) => { await o.showSignInFile(p) }, ...(o.distDir ? { distDir: o.distDir } : {}), ...(o.selfEntry ? { selfEntry: o.selfEntry } : {}) })
  await server.openUi()
  return { mode: 'embedded', origin: server.url, quit: server.stop }
}
