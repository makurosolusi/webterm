/** @vitest-environment jsdom */
// Player against fake MediaSource / SourceBuffer / AudioContext / <audio> (no real browser: real playback is NOT covered here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioChunk } from '../../shared/browser.contract'
import { createAudioPlayer, JITTER_S, TEXT } from './browserAudio.player'
import type { AudioPlayerView } from './browserAudio.player'

class FakeSB {
  updating = false
  ranges: Array<[number, number]> = []
  appended: Uint8Array[] = []
  removed: Array<[number, number]> = []
  throwQuota = 0
  ls: Array<() => void> = []
  buffered = { get length() { return 0 }, start: (i: number) => this.ranges[i][0], end: (i: number) => this.ranges[i][1] } as unknown as TimeRanges
  addEventListener(_t: string, f: () => void) { this.ls.push(f) }
  appendBuffer(b: Uint8Array) {
    if (this.throwQuota > 0) { this.throwQuota--; const e = new Error('full'); e.name = 'QuotaExceededError'; throw e }
    if (this.updating) throw new Error('InvalidStateError: updating')
    this.updating = true; this.appended.push(b)
  }
  remove(a: number, b: number) { this.updating = true; this.removed.push([a, b]) }
  /** Finish the running operation, optionally changing the buffered range, and fire updateend. */
  done(range?: [number, number]) {
    this.updating = false
    if (range) this.ranges = [range]
    Object.defineProperty(this.buffered, 'length', { configurable: true, value: this.ranges.length })
    for (const f of this.ls) f()
  }
}
class FakeMS {
  static supported = true
  static all: FakeMS[] = []
  static isTypeSupported() { return FakeMS.supported }
  readyState = 'open'
  sb: FakeSB | null = null
  open: Array<() => void> = []
  constructor() { FakeMS.all.push(this) }
  addEventListener(_t: string, f: () => void) { this.open.push(f) }
  addSourceBuffer() { this.sb = new FakeSB(); return this.sb }
  endOfStream() { this.readyState = 'ended' }
  fireOpen() { for (const f of this.open) f() }
}
class FakeEl {
  static all: FakeEl[] = []
  paused = true
  currentTime = 0
  src = ''
  ls: Record<string, () => void> = {}
  constructor() { FakeEl.all.push(this) }
  addEventListener(t: string, f: () => void) { this.ls[t] = f }
  removeAttribute() {}
  load() {}
  pause() { this.paused = true }
  play() { this.paused = false; return Promise.resolve() }
}
const ctxs: FakeCtx[] = []
class FakeCtx {
  currentTime = 0
  destination = {}
  resume = vi.fn(() => Promise.resolve())
  close = vi.fn(() => Promise.resolve())
  constructor() { ctxs.push(this) }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
  createMediaElementSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
}

const chunk = (streamKey: string, seq: number): AudioChunk => ({ nodeId: 'n', streamKey, seq, t: 0, payload: new Uint8Array([seq]) })
const flush = () => Promise.resolve()

function setup() {
  const views: AudioPlayerView[] = []
  const p = createAudioPlayer((v) => views.push(v))
  return { p, views }
}
/** start + first sourceopen: returns the live SourceBuffer. */
function started() {
  const s = setup()
  s.p.start()
  const ms = FakeMS.all.at(-1)!
  ms.fireOpen()
  return { ...s, ms, sb: ms.sb!, el: FakeEl.all[0] }
}

beforeEach(() => {
  FakeMS.supported = true; FakeMS.all = []; FakeEl.all = []; ctxs.length = 0
  vi.stubGlobal('MediaSource', FakeMS)
  vi.stubGlobal('AudioContext', FakeCtx)
  vi.stubGlobal('Audio', FakeEl)
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())

describe('browserAudio.player', () => {
  it('unsupported: state + human message, no AudioContext, no stream', () => {
    FakeMS.supported = false
    const { p, views } = setup()
    p.start()
    expect(views.at(-1)).toEqual({ state: 'unsupported', message: TEXT.unsupported })
    expect(ctxs).toHaveLength(0)
    expect(FakeMS.all).toHaveLength(0)
  })

  it('start creates and resumes one AudioContext (reused across stop/start)', () => {
    const { p } = setup()
    p.start(); p.stop(); p.start()
    expect(ctxs).toHaveLength(1)
    expect(ctxs[0].resume).toHaveBeenCalledTimes(2)
  })

  it('appends in order, one at a time: a chunk arriving while updating waits for updateend', () => {
    const { p, sb } = started()
    p.push(chunk('a', 0)); p.push(chunk('a', 1)); p.push(chunk('a', 2))
    expect(sb.appended.map((b) => b[0])).toEqual([0])
    sb.done(); expect(sb.appended.map((b) => b[0])).toEqual([0, 1])
    sb.done(); sb.done()
    expect(sb.appended.map((b) => b[0])).toEqual([0, 1, 2])
  })

  it('ignores a mid-stream chunk until its header (seq 0) arrives', () => {
    const { p, sb } = started()
    p.push(chunk('a', 5)); p.push(chunk('a', 6))
    expect(sb.appended).toHaveLength(0)
    p.push(chunk('a', 0))
    expect(sb.appended).toHaveLength(1)
  })

  it('starts playing only after the jitter buffer is filled, then reports playing', async () => {
    const { p, sb, el, views } = started()
    p.push(chunk('a', 0))
    sb.done([0, JITTER_S / 3])
    expect(el.paused).toBe(true)
    p.push(chunk('a', 1))
    sb.done([0, JITTER_S * 2])
    await flush()
    expect(el.paused).toBe(false)
    expect(el.currentTime).toBeCloseTo(JITTER_S)
    el.ls.playing()
    expect(views.at(-1)?.state).toBe('playing')
  })

  it('jumps to the live edge when more than 500 ms behind', () => {
    const { p, sb, el } = started()
    p.push(chunk('a', 0)); sb.done([0, 1])
    el.paused = false; el.currentTime = 0.2
    p.push(chunk('a', 1)); sb.done([0, 2])
    expect(el.currentTime).toBeCloseTo(2 - JITTER_S)
  })

  it('trims old played audio when idle', () => {
    const { p, sb, el } = started()
    p.push(chunk('a', 0)); sb.done([0, 30])
    el.paused = false; el.currentTime = 29.9
    p.push(chunk('a', 1)); sb.done([0, 30.1])
    sb.done([0, 30.1]) // idle pass after the queue is empty
    expect(sb.removed.length).toBeGreaterThan(0)
  })

  it('a new streamKey resets everything: new MediaSource, old one ended, old URL revoked', () => {
    const { p, ms } = started()
    p.push(chunk('a', 0))
    p.push(chunk('b', 3)) // not a header: ignored, stream a continues
    expect(FakeMS.all).toHaveLength(1)
    p.push(chunk('b', 0))
    expect(FakeMS.all).toHaveLength(2)
    expect(ms.readyState).toBe('ended')
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    FakeMS.all[1].fireOpen()
    expect(FakeMS.all[1].sb!.appended.map((b) => b[0])).toEqual([0])
  })

  it('QuotaExceededError: trims played audio then retries the same chunk', () => {
    const { p, sb, el } = started()
    el.paused = false; el.currentTime = 4.9
    p.push(chunk("a", 0)); sb.done([0, 5.1])
    sb.throwQuota = 1
    p.push(chunk('a', 1))
    expect(sb.removed).toEqual([[0, 4.9]])
    sb.done([6, 6.4]) // the remove finished: the chunk is appended again
    expect(sb.appended.map((b) => b[0])).toEqual([0, 1])
  })

  it('persistent quota failure ends in an error state, not a silent loop', () => {
    const { p, sb, views } = started()
    p.push(chunk('a', 0)); sb.done([0, 10])
    sb.throwQuota = 99
    p.push(chunk('a', 1))
    for (let i = 0; i < 6; i++) sb.done([0, 10])
    expect(views.at(-1)?.state).toBe('error')
  })

  it('stop and dispose: idle, URL revoked, context closed only on dispose', () => {
    const { p, views } = started()
    p.stop()
    expect(views.at(-1)?.state).toBe('idle')
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    expect(ctxs[0].close).not.toHaveBeenCalled()
    p.dispose()
    expect(ctxs[0].close).toHaveBeenCalled()
  })

  it('push after stop is dropped', () => {
    const { p, sb } = started()
    p.stop()
    p.push(chunk('a', 0))
    expect(sb.appended).toHaveLength(0)
  })
})
