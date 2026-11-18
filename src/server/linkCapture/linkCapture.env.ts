// What a terminal session gets so that links it opens land in the canvas browser: BROWSER, the shim dir
// first on PATH, the port, and (plain terminals only) the path of the limited link header file. Applied to
// EVERY session (plain terminal and agents); agents already carry the node header file the shim prefers.
import { delimiter } from 'node:path'
import { isEnabled } from '../featureCapabilities.runtime'
import { captureLinksOn, LINK_HEADERS_ENV } from './linkCapture.config'
import { linkHeadersPath, writeLinkHeaders } from './linkCapture.identity'
import { openCommandPath, shimDir } from './linkCapture.shims'
import { pathPrefix, shellHookEnv } from './linkCapture.shell'

/** True when new sessions get the capture env: the Settings switch is on AND the canvas browser exists. */
export const captureActive = (env: Record<string, string | undefined> = process.env): boolean => captureLinksOn(env) && isEnabled('browser', env)

/** `base` PATH with the shim dir first (and only once). */
export const shimFirstPath = (base: string = process.env.PATH ?? ''): string =>
  [shimDir(), ...base.split(delimiter).filter((p) => p && p !== shimDir())].join(delimiter)

export interface CaptureEnvInput {
  nodeId: string
  /** An agent session: it carries the node header file already, so no link header file is written for it. */
  agent: boolean
  port: number
  /** Resolved shell binary. */
  shell: string
  /** The shell starts interactively (no command): the rc re-ordering hooks apply. A command launch gets `withCapturePrefix` instead. */
  interactive: boolean
  /** False in tests that must not write the link header file into the data dir (its path is still reported). */
  writeFiles: boolean
}

/** Env additions of one session; `{}` is never returned (the caller gates on `captureActive`). */
export function captureEnv(i: CaptureEnvInput, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    BROWSER: openCommandPath(),
    PATH: shimFirstPath(base.PATH),
    WEBTERM_PORT: String(i.port),
    ...(i.agent ? {} : { [LINK_HEADERS_ENV]: i.writeFiles ? writeLinkHeaders(i.nodeId) : linkHeadersPath(i.nodeId) }),
    ...(i.interactive ? shellHookEnv(i.shell, shimDir(), base) : {}),
  }
}

/** The launch command with the shim dir put first on PATH after the login rc files ran. */
export const withCapturePrefix = (cmd: string, shell: string): string => `${pathPrefix(shell, shimDir())}${cmd}`
