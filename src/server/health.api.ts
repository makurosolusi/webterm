// Server identity (`bootId` + `build`) and `GET /api/health`.
// The client compares both across reconnects: a new `bootId` = the server restarted (its PTYs are
// gone), a new `build` = the UI bundle in this tab is stale. The route sits behind the normal /api
// gate, so a client whose socket keeps failing can tell "server down" (network error) from "my
// credential is no longer accepted" (401/403) and stop retrying instead of looping.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import pkg from '../../package.json'
import { HEALTH_PATH } from '../shared/protocol'

export interface ServerIdentity {
  /** Random per process start. */
  bootId: string
  /** `<package version>+<short hash of dist/index.html>`, or `<version>+dev` without a build. */
  build: string
}

/**
 * Identity of this process. `dist/index.html` names every hashed asset, so its hash changes with
 * any client rebuild. Dev mode never reads dist (Vite serves the source) and reports `dev`.
 * ponytail: a `--compile` binary without dist on disk reports `dev`; hash the embedded manifest if
 * stale-bundle detection is needed there.
 */
export function createServerIdentity(opts: { distDir: string; dev: boolean }): ServerIdentity {
  let tag = 'dev'
  if (!opts.dev) {
    try {
      tag = createHash('sha256').update(readFileSync(join(opts.distDir, 'index.html'))).digest('hex').slice(0, 10)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`read ${opts.distDir}/index.html for the build id failed`, { cause: err })
    }
  }
  return { bootId: randomUUID(), build: `${pkg.version}+${tag}` }
}

/** Answers `GET /api/health` (call after the /api auth gate); true = handled. */
export function healthRoute(req: IncomingMessage, res: ServerResponse, pathname: string, id: ServerIdentity): boolean {
  if (pathname !== HEALTH_PATH) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    res.end()
    return true
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ bootId: id.bootId, build: id.build }))
  return true
}
