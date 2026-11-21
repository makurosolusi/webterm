// The injected capture script run in a vm against a fake audio graph: patch order, lazy bus, recorder only while wanted, frozen prototypes.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { AUDIO_BINDING } from '../../shared/browser.contract'
import { audioInjectSource, AUDIO_PAUSE_FN, AUDIO_RESUME_FN } from './browser.audio.inject'

interface FakeRecorder { stopped: boolean; emit(n: number): void }

function world(opts: { freeze?: boolean; noBinding?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const log = { contexts: 0, sources: 0, resumes: 0, recorders: [] as FakeRecorder[] }
  const pageCtx = { createGain: () => new AudioNode(), createMediaStreamDestination: () => ({ stream: {} }) } // the page's own context, not ours
  class AudioNode { context: unknown = pageCtx; connect(d: unknown) { return d } disconnect() { return undefined } }
  class AudioDestinationNode extends AudioNode {}
  class AudioContext {
    state = 'suspended' // autoplay policy: no user activation yet
    constructor() { log.contexts++ }
    createMediaStreamDestination() { return { stream: {} } }
    createMediaElementSource() { log.sources++; return new AudioNode() }
    createMediaStreamSource() { return new AudioNode() }
    createGain() { return new AudioNode() }
    resume() { log.resumes++; return Promise.resolve() }
  }
  class HTMLMediaElement { play() { return Promise.resolve() } }
  class MediaRecorder {
    stopped = false
    ondataavailable?: (e: unknown) => void
    constructor() { log.recorders.push(this) }
    start() { return undefined }
    stop() { this.stopped = true }
    emit(n: number) { this.ondataavailable?.({ data: { size: n, arrayBuffer: async () => new Uint8Array(n).buffer } }) }
  }
  if (opts.freeze) { Object.freeze(AudioNode.prototype); Object.freeze(HTMLMediaElement.prototype) }
  const ctx: Record<string, unknown> = {
    frames: [], addEventListener: () => undefined,
    AudioNode, AudioDestinationNode, AudioContext, HTMLMediaElement, MediaRecorder,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
  }
  ctx.window = ctx
  ctx.parent = ctx
  if (!opts.noBinding) ctx[AUDIO_BINDING] = (s: string) => sent.push(JSON.parse(s))
  runInNewContext(audioInjectSource(), ctx)
  return { ctx, sent, log, media: new HTMLMediaElement(), node: new AudioNode(), dest: new AudioDestinationNode() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('inject script', () => {
  it('creates nothing until a source appears (lazy bus)', () => {
    const w = world()
    expect(w.log.contexts).toBe(0)
    expect(w.sent).toEqual([])
  })

  it('play() builds the bus once, routes the element into it and announces the stream', async () => {
    const w = world()
    await w.media.play(); await w.media.play()
    expect(w.log.contexts).toBe(1)
    expect(w.log.sources).toBe(1)
    expect(w.sent.filter((m) => m.k === 'b')).toHaveLength(1)
  })

  it('records only while resumed; each run is a new stream key and seq starts at 0', async () => {
    const w = world()
    await w.media.play()
    expect(w.log.recorders).toHaveLength(0) // nobody listens yet: no recorder, no CPU
    const resume = w.ctx[AUDIO_RESUME_FN] as () => void
    const pause = w.ctx[AUDIO_PAUSE_FN] as () => void
    resume(); resume()
    expect(w.log.recorders).toHaveLength(1)
    w.log.recorders[0].emit(10); await tick()
    pause()
    expect(w.log.recorders[0].stopped).toBe(true)
    resume()
    expect(w.log.recorders).toHaveLength(2)
    w.log.recorders[1].emit(5); await tick()
    const chunks = w.sent.filter((m) => m.k === 'c')
    expect(chunks.map((c) => c.s)).toEqual([0, 0])
    expect(chunks[0].f).not.toBe(chunks[1].f)
  })

  it('resume() also resumes a bus the autoplay policy left suspended (the host calls it inside a user activation)', async () => {
    const w = world()
    await w.media.play()
    const before = w.log.resumes
    ;(w.ctx[AUDIO_RESUME_FN] as () => void)()
    expect(w.log.resumes).toBe(before + 1)
  })

  it('a WebAudio connect to the destination tees into the bus', () => {
    const w = world()
    w.node.connect(w.dest)
    expect(w.log.contexts).toBe(1)
    expect(w.sent.some((m) => m.k === 'b')).toBe(true)
  })

  it('does not throw when the page froze the prototypes, and without a binding it installs nothing', () => {
    expect(() => world({ freeze: true })).not.toThrow()
    expect(world({ noBinding: true }).ctx[AUDIO_RESUME_FN]).toBeUndefined()
  })
})
