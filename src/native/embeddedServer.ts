// Runs the webterm server inside THIS process on a loopback port: the native app's main process
// (src/native/nativeApp.ts) and the start/stop test use it. Plain Bun/Node, no Electrobun import.
import { createServer, type AddressInfo } from 'node:net'
import { registerEmbedHost } from '../server/embedHost'

/** The native app never listens beyond this machine. */
export const LOOPBACK_HOST = '127.0.0.1'

export interface EmbeddedServer {
  /** Origin the server answers on, e.g. http://127.0.0.1:53211. */
  url: string
  /** Mint a one-time code, write the 0600 sign-in file and hand its path to `openFile`. */
  openUi(): Promise<void>
  /** Close the listeners (main + dev proxy), every socket and the stores; the ports are free afterwards. */
  stop(): Promise<void>
}

/** A port the OS just handed out on loopback (closed again, so the server can bind it). */
export async function freeLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, LOOPBACK_HOST, resolve) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Start the server in-process. Host/port go through the env the CLI reads (PTY children never see them:
 *  ptyShell LEAKED_ENV strips HOST/PORT). Call once per process: index.ts is a boot module. */
export async function startEmbeddedServer(o: { port: number; openFile: (path: string) => Promise<void>; distDir?: string; selfEntry?: string }): Promise<EmbeddedServer> {
  process.env.HOST = LOOPBACK_HOST
  process.env.PORT = String(o.port)
  registerEmbedHost({ openFile: o.openFile, ...(o.distDir ? { distDir: o.distDir } : {}), ...(o.selfEntry ? { selfEntry: o.selfEntry } : {}) })
  const server = await import('../server/index')
  const { host, port } = await server.ready
  return { url: `http://${host}:${port}`, openUi: server.openUi, stop: server.stopServer }
}
