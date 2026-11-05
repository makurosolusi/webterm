// Console of each browser node (imitates Chrome DevTools Console). Log is enabled on every page session; Runtime
// only once a node's console is actually used (drawer opened, agent `console` read, eval), because Runtime.enable is
// detectable by anti-bot scripts and the browser otherwise hides automation. Once on, it stays on for that node
// (memory only) and is re-enabled when the target is recreated. Console API calls, uncaught exceptions and browser log entries land in a per-node ring buffer and
// stream to viewers as batched deltas. Main-frame navigation clears it unless "Preserve log" is on (Chrome's
// default), in which case a "Navigated to <url>" separator is inserted. Entries are page content: they may hold
// tokens, so they are NEVER written to the server log.
import { CONSOLE_BATCH_MAX, CONSOLE_BUFFER_MAX, CONSOLE_FLUSH_MS, atLeast } from '../../shared/browser.console'
import type { ConsoleClientMsg, ConsoleDelta, ConsoleEntry, ConsoleLevel } from '../../shared/browser.console'
import { CDP, CDP_EVENT } from './cdp.client'
import type { CdpClient, CdpHandler } from './cdp.client'
import { clipText, formatRemote, fromConsoleApi, fromException, fromLogEntry } from './browserHost.console.format'
import type { EntryBody, RemoteObj } from './browserHost.console.format'
import { BrowserError, isInternalUrl } from './browserHost.targets'
import type { NodeRec, TargetTable } from './browserHost.targets'

/** Object group of eval results; released on Clear so the page can collect them. */
const EVAL_GROUP = 'console'

export interface ConsoleOps {
  table: TargetTable
  /** Command on the node's page session (the host's `send`). */
  send(rec: NodeRec, method: string, params?: object): Promise<Record<string, unknown>>
  now?: () => number
}

export interface ConsoleLog {
  /** Enable Log (and Runtime when the node's capture is already on) on a new page session. */
  enable(cdp: CdpClient, sessionId: string): Promise<void>
  /** `'*'` handler for one CDP connection. */
  route: CdpHandler
  /** Full buffer as a reset delta (sent to a viewer on attach). */
  snapshot(nodeId: string): ConsoleDelta
  /** Newest `limit` entries at or above `min` (agent `console` verb). */
  read(nodeId: string, limit: number, min: ConsoleLevel): { entries: ConsoleEntry[]; dropped: number }
  /** Turn on console capture (Runtime) for a node; true when it was off until now. */
  capture(nodeId: string): Promise<boolean>
  /** User action from the node UI: open / eval / clear / preserve. Eval is gated by the caller like user input. */
  command(msg: ConsoleClientMsg): Promise<void>
  /** Listen to batched deltas; returns unsubscribe. */
  onDelta(cb: (d: ConsoleDelta) => void): () => void
}

interface Buf { entries: ConsoleEntry[]; dropped: number; preserve: boolean; capturing: boolean; seq: number; pending: ConsoleEntry[]; reset: boolean; timer?: ReturnType<typeof setTimeout> }

export function createConsoleLog(ops: ConsoleOps): ConsoleLog {
  const now = ops.now ?? Date.now
  const bufs = new Map<string, Buf>()
  const cbs = new Set<(d: ConsoleDelta) => void>()
  const buf = (id: string): Buf => {
    let b = bufs.get(id)
    if (!b) bufs.set(id, (b = { entries: [], dropped: 0, preserve: false, capturing: false, seq: 0, pending: [], reset: false }))
    return b
  }

  const flush = (id: string) => {
    const b = buf(id)
    b.timer = undefined
    const entries = b.pending.slice(-CONSOLE_BATCH_MAX)
    const d: ConsoleDelta = { id, entries, dropped: b.dropped, preserve: b.preserve, capturing: b.capturing, ...(b.reset ? { reset: true as const } : {}) }
    b.pending = []
    b.reset = false
    for (const cb of cbs) cb(d)
  }
  const schedule = (id: string, b: Buf) => { b.timer ??= setTimeout(() => flush(id), CONSOLE_FLUSH_MS) }

  const push = (id: string, body: EntryBody) => {
    const b = buf(id)
    const e: ConsoleEntry = { seq: ++b.seq, ts: now(), ...body }
    b.entries.push(e)
    if (b.entries.length > CONSOLE_BUFFER_MAX) { b.entries.shift(); b.dropped++ }
    b.pending.push(e)
    if (b.pending.length > CONSOLE_BUFFER_MAX) b.pending.shift()
    schedule(id, b)
  }
  const clear = (id: string) => {
    const b = buf(id)
    b.entries = []
    b.pending = []
    b.dropped = 0
    b.reset = true
    schedule(id, b)
  }

  const onNavigated = (rec: NodeRec, p: Record<string, unknown>) => {
    const f = p.frame as { parentId?: string; url?: string } | undefined
    if (!f?.url || f.parentId) return
    const b = buf(rec.nodeId)
    if (!b.preserve) { clear(rec.nodeId); return }
    if (!isInternalUrl(f.url)) push(rec.nodeId, { level: 'info', source: 'system', text: clipText(`Navigated to ${f.url}`) })
  }

  const recOf = (nodeId: string, what: string): NodeRec => {
    const rec = ops.table.nodes.get(nodeId)
    if (!rec) throw new BrowserError('not_found', `${what}: unknown node ${nodeId}`)
    return rec
  }
  const capture = async (rec: NodeRec): Promise<boolean> => {
    const b = buf(rec.nodeId)
    if (b.capturing) return false
    b.capturing = true // set before the await: concurrent callers send Runtime.enable once
    schedule(rec.nodeId, b)
    if (!rec.sessionId) return true // no live target: enable() turns Runtime on when it is (re)created
    try {
      await ops.send(rec, CDP.runtimeEnable)
    } catch (err) {
      b.capturing = false
      schedule(rec.nodeId, b)
      throw new BrowserError('crashed', `console capture: Runtime.enable failed for node ${rec.nodeId}`, undefined, err)
    }
    return true
  }

  const evaluate = async (rec: NodeRec, expr: string) => {
    await capture(rec) // errors the expression throws asynchronously only show with Runtime on
    push(rec.nodeId, { level: 'info', source: 'command', text: clipText(expr) })
    // Chrome's console prompt: REPL mode (let re-declaration, top-level await), user gesture, preview for objects.
    const r = await ops.send(rec, CDP.evaluate, {
      expression: expr, objectGroup: EVAL_GROUP, includeCommandLineAPI: true, silent: false,
      returnByValue: false, generatePreview: true, userGesture: true, replMode: true, awaitPromise: false,
    })
    if (r.exceptionDetails) push(rec.nodeId, fromException(r.exceptionDetails as Parameters<typeof fromException>[0], 'result'))
    else push(rec.nodeId, { level: 'info', source: 'result', text: clipText(formatRemote((r.result ?? { type: 'undefined' }) as RemoteObj, false)) })
  }

  return {
    async enable(cdp, sessionId) {
      // Log (network/CSP/security entries) does not expose page objects to the page, so it is not an automation tell.
      await cdp.send(CDP.logEnable, {}, sessionId)
      const rec = ops.table.session(sessionId)
      if (rec && buf(rec.nodeId).capturing) await cdp.send(CDP.runtimeEnable, {}, sessionId)
    },

    capture: async (nodeId) => capture(recOf(nodeId, 'console capture')),

    route(p, sessionId, method) {
      const rec = ops.table.session(sessionId)
      if (!rec) return // iframe/worker sessions are not part of the page console here
      switch (method) {
        case CDP_EVENT.consoleApiCalled: {
          const body = fromConsoleApi(p)
          if (body === 'clear') { clear(rec.nodeId); push(rec.nodeId, { level: 'info', source: 'system', text: 'Console was cleared' }) }
          else if (body) push(rec.nodeId, body)
          return
        }
        case CDP_EVENT.exceptionThrown: return push(rec.nodeId, fromException((p.exceptionDetails ?? {}) as Parameters<typeof fromException>[0]))
        case CDP_EVENT.logEntryAdded: { const body = fromLogEntry(p); if (body) push(rec.nodeId, body); return }
        case CDP_EVENT.frameNavigated: return onNavigated(rec, p)
      }
    },

    snapshot(nodeId) {
      const b = buf(nodeId)
      return { id: nodeId, entries: [...b.entries], dropped: b.dropped, preserve: b.preserve, capturing: b.capturing, reset: true }
    },

    read(nodeId, limit, min) {
      const b = buf(nodeId)
      return { entries: b.entries.filter((e) => atLeast(e.level, min)).slice(-limit), dropped: b.dropped }
    },

    async command(m) {
      const rec = recOf(m.id, 'console')
      if (m.op === 'open') { await capture(rec); return }
      if (m.op === 'preserve') { const b = buf(m.id); b.preserve = m.on; schedule(m.id, b); return }
      if (m.op === 'clear') {
        clear(m.id)
        if (rec.sessionId) await ops.send(rec, CDP.releaseObjectGroup, { objectGroup: EVAL_GROUP })
        return
      }
      if (!rec.sessionId) throw new BrowserError('crashed', `console eval: node ${m.id} has no live browser target`)
      await evaluate(rec, m.expr)
    },

    onDelta(cb) {
      cbs.add(cb)
      return () => { cbs.delete(cb) }
    },
  }
}
