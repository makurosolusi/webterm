import type { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import type { Sessions } from './sessions'
import type { fsWatchHub } from './fsWatch'
import { createLogger } from './logs'
import type { ServerIdentity } from './health.api'
import { createStreamBridge, type StreamDispatch, type UpgradeIdentity } from './sseBridge'

/**
 * One terminal WebSocket (`/ws`): message dispatch plus the two guards a long-lived socket needs.
 *
 * Backpressure: `ws` queues every unsent frame in
 * user space without limit, so a stalled tab made server memory grow with PTY output. Above
 * `WS_DROP_BYTES` queued, that terminal's output is DROPPED for this socket and the terminal is
 * marked lagging; status/exit/reset still go out. A sweep resyncs every lagging terminal (reset +
 * full replay from its `OutputLog`) once the queue drains below `WS_LOW_BYTES`.
 *
 * Heartbeat, the `ws` README pattern: ping every `WS_HEARTBEAT_MS`, `terminate()` a socket that did
 * not answer the previous ping, so a half-open connection stops holding subscriptions forever.
 * Browsers cannot see those pings, so the client also sends app-level `{t:'ping'}` and expects
 * `{t:'pong'}`; and every connection opens with `{t:'hello', bootId, build}` (health.api.ts).
 */

/** Queued bytes above which a socket gets no more output. */
export const WS_DROP_BYTES = 8_000_000
/** Queued bytes at or below which lagging terminals are resynced. */
export const WS_LOW_BYTES = 256_000
/** How often a lagging socket is checked for drain. */
export const WS_RESYNC_SWEEP_MS = 250
/** Ping interval; a socket that misses one pong is terminated. */
export const WS_HEARTBEAT_MS = 30_000

export interface TerminalSocketDeps {
  /** `statusSnapshot` absent = no status frames on connect (tests that do not care). */
  sessions: Pick<Sessions, 'handle' | 'detach' | 'resync'> & Partial<Pick<Sessions, 'statusSnapshot'>>
  fsWatchHub: Pick<typeof fsWatchHub, 'watch' | 'unwatch' | 'dropClient'>
  /** Files watch capability; off = fswatch/fsunwatch are ignored. */
  watchOn: () => boolean
  /** Connected client count, for the connect log line. */
  clients: () => number
  /** Sent as the first frame (`hello`); absent in tests that do not care. */
  identity?: ServerIdentity
  /** SSE routes over this socket (`sse.sub`): the upgrade's identity + the HTTP gate/dispatcher. Absent = refused. */
  streams?: { upgrade: UpgradeIdentity; dispatch: StreamDispatch }
}

type Socket = Pick<WebSocket, 'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'ping' | 'terminate' | 'on'>

const wsLog = createLogger('ws')

export function serveTerminalSocket(ws: Socket, deps: TerminalSocketDeps): void {
  wsLog.info('ws.connect', 'WebSocket client connected', { clients: deps.clients() })
  const lagging = new Set<string>()
  let sweep: ReturnType<typeof setInterval> | undefined

  const resync = (): void => {
    if (ws.readyState !== ws.OPEN || ws.bufferedAmount > WS_LOW_BYTES) return
    clearInterval(sweep)
    sweep = undefined
    const ids = [...lagging]
    lagging.clear()
    // Byte counts only, never terminal content: tells "output was dropped, then replayed" from "never dropped".
    wsLog.debug('ws.resync', 'WebSocket drained; replaying terminals whose output was dropped', { terminals: ids.length, bufferedBytes: ws.bufferedAmount })
    for (const id of ids) deps.sessions.resync(id, send)
  }

  const send = (m: ServerMsg): void => {
    if (ws.readyState !== ws.OPEN) return
    if (m.t === 'output' && (lagging.has(m.id) || ws.bufferedAmount > WS_DROP_BYTES)) {
      if (!lagging.has(m.id)) wsLog.warn('ws.lagging', 'WebSocket send queue over the cap; dropping terminal output until it drains', { ids: { nodeId: m.id }, bufferedBytes: ws.bufferedAmount })
      lagging.add(m.id)
      sweep ??= setInterval(resync, WS_RESYNC_SWEEP_MS)
      return
    }
    // A terminal that ended has nothing left to resync.
    if (m.t === 'exit') lagging.delete(m.id)
    ws.send(JSON.stringify(m))
  }

  if (deps.identity) send({ t: 'hello', bootId: deps.identity.bootId, build: deps.identity.build })
  // Every known status right away: a reloaded tab lists nodes of every board, most of which it never opens.
  for (const m of deps.sessions.statusSnapshot?.() ?? []) send(m)
  const streams = deps.streams ? createStreamBridge(deps.streams.upgrade, send, deps.streams.dispatch, () => ws.bufferedAmount) : null

  let alive = true
  ws.on('pong', () => { alive = true })
  const heartbeat = setInterval(() => {
    if (!alive) {
      wsLog.warn('ws.heartbeat_missed', 'WebSocket client missed a heartbeat; terminating', { intervalMs: WS_HEARTBEAT_MS })
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, WS_HEARTBEAT_MS)

  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(raw)) as ClientMsg
    } catch (err) {
      wsLog.warn('ws.bad_message', 'WebSocket message is not JSON; ignored', { bytes: String(raw).length, error: err })
      return
    }
    // Any frame proves the client is there; a ping is answered here, it is not a session message.
    alive = true
    if (msg?.t === 'ping') { send({ t: 'pong', id: String(msg.id) }); return }
    try {
      // fswatch/fsunwatch are not PTY sessions; with the watch capability off they are ignored.
      if (msg.t === 'sse.sub' || msg.t === 'sse.unsub') {
        if (msg.t === 'sse.unsub') streams?.unsub(msg.id)
        else if (streams) streams.sub(msg.id, msg.url)
        else send({ t: 'sse.end', id: String(msg.id), status: 404 })
      } else if (msg.t === 'fswatch' || msg.t === 'fsunwatch') {
        if (deps.watchOn() && typeof msg.dir === 'string') deps.fsWatchHub[msg.t === 'fswatch' ? 'watch' : 'unwatch'](send, msg.dir)
      } else deps.sessions.handle(msg, send)
    } catch (err) {
      wsLog.error('ws.error', `WebSocket message handling failed (t=${msg?.t})`, { error: err })
    }
  })

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat)
    clearInterval(sweep)
    deps.sessions.detach(send)
    deps.fsWatchHub.dropClient(send)
    streams?.closeAll()
    wsLog.info('ws.disconnect', 'WebSocket client disconnected', { code, reason: reason.toString().slice(0, 120) })
  })
}
