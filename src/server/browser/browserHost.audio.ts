// Server side of browser audio (docs/decisions/browser-audio.md): installs the in-page capture script on every page session
// and OOPIF child, decodes the CDP binding-called chunks into `AudioChunk`s and decides which ones leave the host.
// Rules: chunks flow only while a client listens (`setListening`), only from the node's focused tab (the view session), and
// the recorder in the page runs only while someone listens. Sound is page content: payloads are never logged.
import { AUDIO_BINDING, AUDIO_CHUNK_MAX_BYTES, AUDIO_STREAM_KEY } from '../../shared/browser.contract.audio'
import type { AudioChunk } from '../../shared/browser.contract.audio'
import type { BrowserState } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { audioInjectSource, AUDIO_PAUSE_FN, AUDIO_RESUME_FN } from './browser.audio.inject'
import { CDP, CDP_EVENT, ignoreClosed } from './cdp.client'
import type { CdpClient } from './cdp.client'
import type { NodeRec, TargetTable } from './browserHost.targets'

const log = createLogger('browser.audio')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Init segments kept per node (the current stream plus a few background tabs'); older ones are dropped. */
const INITS_MAX = 4
const BASE64_RATIO = 4 / 3

export interface AudioOps {
  table: TargetTable
  /** Kill switch (`WEBTERM_BROWSER_AUDIO`), read on every page setup. */
  enabled(): boolean
  patch(rec: NodeRec, part: Partial<BrowserState>): void
  now?: () => number
}

export interface AudioHost {
  /** Capture is switched on (kill switch not set). */
  on(): boolean
  /** Install capture on a fresh page session (binding + inject script); never throws (a failure only costs this page its sound). */
  enable(cdp: CdpClient, sessionId: string): Promise<void>
  /** An OOPIF child session attached below `parentSession`: set it up; resolves when it may run (the caller then resumes it). */
  child(cdp: CdpClient, childSession: string, parentSession: string | undefined): Promise<void>
  /** Lose the node's streams (target crashed or discarded). Listening state survives: a woken page resumes by itself. */
  forget(rec: NodeRec): void
  /** Some client listens (true) or none does (false): recorders in the node's pages start or stop. */
  setListening(nodeId: string, on: boolean): void
  /** Does the node's focused tab have an audio stream. */
  isActive(nodeId: string): boolean
  /** The init segment (seq 0) of the stream most recently forwarded for the node, for a listener that joins mid-stream. */
  replay(nodeId: string): AudioChunk | undefined
  onChunk(cb: (c: AudioChunk) => void): () => void
}

interface Msg { k?: unknown; f?: unknown; s?: unknown; d?: unknown }

export function createAudioHost(ops: AudioOps): AudioHost {
  const { table } = ops
  const now = ops.now ?? Date.now
  const source = audioInjectSource()
  const root = new Map<string, string>() // session -> page session it belongs to (itself for a page)
  const cdps = new Map<string, CdpClient>()
  const buses = new Map<string, Set<string>>() // session -> frame ids that created a bus
  const listening = new Set<string>()
  const lastKey = new Map<string, string>() // node -> stream key last forwarded
  const inits = new Map<string, Map<string, AudioChunk>>() // node -> stream key -> seq 0 chunk
  const cbs = new Set<(c: AudioChunk) => void>()
  const hooked = new WeakSet<CdpClient>()

  const ownerOf = (rootSid: string): { rec: NodeRec; view: boolean } | undefined => {
    const v = table.session(rootSid)
    if (v) return { rec: v, view: true }
    const b = table.bgSession(rootSid)
    return b ? { rec: b.rec, view: false } : undefined
  }
  const toggle = (sid: string, on: boolean) => {
    const fn = on ? AUDIO_RESUME_FN : AUDIO_PAUSE_FN
    cdps.get(sid)?.send(CDP.evaluate, { expression: `typeof ${fn}==='function'&&${fn}()` }, sid).catch(ignoreClosed(CDP.evaluate, { sessionId: sid }))
  }
  const sessionsOf = (nodeId: string): string[] => [...root].filter(([, r]) => ownerOf(r)?.rec.nodeId === nodeId).map(([sid]) => sid)

  const recompute = (rec: NodeRec) => {
    const view = rec.sessionId
    const active = !!view && [...root].some(([sid, r]) => r === view && (buses.get(sid)?.size ?? 0) > 0)
    if ((rec.state.audioActive ?? false) !== active) ops.patch(rec, { audioActive: active ? true : undefined })
  }

  const drop = (sid: string) => {
    const r = root.get(sid)
    root.delete(sid); cdps.delete(sid); buses.delete(sid)
    const owner = r ? ownerOf(r) : undefined
    if (owner) recompute(owner.rec)
  }

  const keepInit = (nodeId: string, c: AudioChunk) => {
    if (c.seq !== 0) return
    const m = inits.get(nodeId) ?? new Map<string, AudioChunk>()
    inits.set(nodeId, m)
    m.set(c.streamKey, c)
    while (m.size > INITS_MAX) m.delete(m.keys().next().value as string)
  }

  function onBinding(p: Record<string, unknown>, sid: string | undefined): void {
    if (p.name !== AUDIO_BINDING || !sid) return
    const r = root.get(sid)
    if (!r) return
    let m: Msg
    try { m = JSON.parse(String(p.payload)) as Msg } catch (err) { log.warn('browser.audio.bad', 'page sent an unreadable audio message', { error: errMsg(err) }); return }
    const owner = ownerOf(r)
    if (!owner) return
    const nodeId = owner.rec.nodeId
    if (m.k === 'b') {
      let set = buses.get(sid)
      if (!set) buses.set(sid, (set = new Set()))
      set.add(String(m.f))
      recompute(owner.rec)
      if (listening.has(nodeId)) toggle(sid, true)
      return
    }
    if (m.k !== 'c' || !listening.has(nodeId)) return
    const key = m.f, seq = m.s, d = m.d
    if (typeof key !== 'string' || !AUDIO_STREAM_KEY.test(key) || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || typeof d !== 'string') return
    if (d.length > AUDIO_CHUNK_MAX_BYTES * BASE64_RATIO + 8) { log.warn('browser.audio.big', 'audio chunk over the size limit dropped', { ids: { nodeId } }); return }
    const chunk: AudioChunk = { nodeId, streamKey: key, seq, t: now(), payload: Buffer.from(d, 'base64') }
    keepInit(nodeId, chunk)
    if (!owner.view) return // a background tab is muted on the server; its init segment is kept for when it gets focus
    const first = lastKey.get(nodeId) !== key
    lastKey.set(nodeId, key)
    const init = first && seq !== 0 ? inits.get(nodeId)?.get(key) : undefined
    for (const cb of cbs) { if (init) cb(init); cb(chunk) }
  }

  function hook(cdp: CdpClient): void {
    if (hooked.has(cdp)) return
    hooked.add(cdp)
    cdp.on(CDP_EVENT.bindingCalled, (p, sid) => onBinding(p, sid))
    cdp.on(CDP_EVENT.frameNavigated, (p, sid) => {
      const f = p.frame as { parentId?: string } | undefined
      if (!sid || f?.parentId || root.get(sid) !== sid) return // main frame of a page session: its old realms are gone
      const owner = ownerOf(sid)
      for (const [s, r] of root) if (r === sid) buses.delete(s)
      if (owner) { lastKey.delete(owner.rec.nodeId); recompute(owner.rec) }
    })
    cdp.on(CDP_EVENT.detachedFromTarget, (p) => { if (typeof p.sessionId === 'string') drop(p.sessionId) })
  }

  async function setup(cdp: CdpClient, sid: string, immediate: boolean): Promise<void> {
    await cdp.send(CDP.runtimeEnable, {}, sid) // the spike needed it for binding-called events to reach this session
    await cdp.send(CDP.addBinding, { name: AUDIO_BINDING }, sid)
    await cdp.send(CDP.addScript, { source, ...(immediate ? { runImmediately: true } : {}) }, sid)
  }

  return {
    on: () => ops.enabled(),

    async enable(cdp, sid) {
      if (!ops.enabled()) return
      hook(cdp)
      root.set(sid, sid); cdps.set(sid, cdp)
      try { await setup(cdp, sid, false) } catch (err) { log.warn('browser.audio.enable', 'audio capture could not be installed on a page', { sessionId: sid, error: errMsg(err) }) }
    },

    async child(cdp, childSid, parentSid) {
      if (!ops.enabled()) return
      hook(cdp)
      const r = parentSid ? root.get(parentSid) : undefined
      if (!r) return
      root.set(childSid, r); cdps.set(childSid, cdp)
      try {
        await cdp.send(CDP.pageEnable, {}, childSid)
        await setup(cdp, childSid, true)
      } catch (err) { log.warn('browser.audio.child', 'audio capture could not be installed in an iframe', { sessionId: childSid, error: errMsg(err) }) }
    },

    forget(rec) {
      for (const sid of sessionsOf(rec.nodeId)) { root.delete(sid); cdps.delete(sid); buses.delete(sid) }
      lastKey.delete(rec.nodeId); inits.delete(rec.nodeId)
      if (rec.state.audioActive) ops.patch(rec, { audioActive: undefined })
    },

    setListening(nodeId, on) {
      if (on === listening.has(nodeId)) return
      if (on) listening.add(nodeId); else { listening.delete(nodeId); lastKey.delete(nodeId) }
      for (const sid of sessionsOf(nodeId)) toggle(sid, on)
    },

    isActive: (nodeId) => table.nodes.get(nodeId)?.state.audioActive === true,
    replay(nodeId) { const k = lastKey.get(nodeId); return k ? inits.get(nodeId)?.get(k) : undefined },
    onChunk(cb) { cbs.add(cb); return () => { cbs.delete(cb) } },
  }
}
