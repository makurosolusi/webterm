// Plays the opus/webm chunks of one browser node (docs/decisions/browser-audio.md, "Client contract").
// Design: MediaSource + SourceBuffer(audio/webm;codecs=opus) -> hidden <audio> -> createMediaElementSource -> GainNode -> destination.
// Why MSE and not decodeAudioData: MediaRecorder chunks are fragments of ONE WebM stream (only seq 0 is decodable alone), so a
// streaming demuxer is needed. Why the element goes through an AudioContext: the context is created/resumed by the click
// (the autoplay gesture) and its gain gives a click-free start/reset (gain 0 while the pipeline is rebuilt, short ramp up).
// A new streamKey = full reset (new MediaSource): the new stream restarts its timestamps at 0, so reusing the buffer would overlap.
import { AUDIO_MIME } from '../../shared/browser.contract'
import type { AudioChunk } from '../../shared/browser.contract'

export type AudioPlayerState = 'idle' | 'connecting' | 'playing' | 'unsupported' | 'error'
export interface AudioPlayerView { state: AudioPlayerState; message: string }

/** Playback delay kept before (re)starting, in seconds: enough to ride out network jitter between ~100 ms chunks. */
export const JITTER_S = 0.15
/** Behind the newest buffered audio by more than this = jump to the live edge, in seconds. */
export const LIVE_JUMP_S = 0.5
/** Played audio older than this is removed so the buffer stays small, in seconds. */
const KEEP_BEHIND_S = 5
const MAX_QUOTA_RETRIES = 3
const FADE_S = 0.03
export const TEXT = {
  unsupported: 'This browser cannot play the browser node\'s audio (no WebM/Opus streaming support).',
  failed: 'Audio playback failed.',
  blocked: 'Audio was blocked by the browser. Click the speaker to try again.',
}

/** MSE + WebM/Opus available here (checked up front by the button, again by `start`). */
export const audioSupported = (): boolean => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(AUDIO_MIME)

export interface AudioPlayer {
  /** Must run inside the click handler: creates/resumes the AudioContext and opens the stream. */
  start(): void
  push(chunk: AudioChunk): void
  /** Stops playback and drops the stream; the AudioContext stays for the next start. */
  stop(): void
  /** stop + close the AudioContext. */
  dispose(): void
  get(): AudioPlayerView
}

export function createAudioPlayer(onChange: (v: AudioPlayerView) => void): AudioPlayer {
  let view: AudioPlayerView = { state: 'idle', message: '' }
  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let el: HTMLAudioElement | null = null
  let source: MediaElementAudioSourceNode | null = null
  let ms: MediaSource | null = null
  let sb: SourceBuffer | null = null
  let url = ''
  let key = ''
  let queue: Uint8Array[] = []
  let quotaRetries = 0
  let running = false

  const set = (state: AudioPlayerState, message = ''): void => {
    if (view.state === state && view.message === message) return
    view = { state, message }
    onChange(view)
  }
  const fail = (message: string): void => { teardown(); set('error', message) }
  const errText = (e: unknown): string => e instanceof Error ? e.message : String(e)

  function teardown(): void {
    running = false
    queue = []
    sb = null
    key = ''
    quotaRetries = 0
    if (el) { el.pause(); el.removeAttribute('src'); el.load() }
    if (ms && ms.readyState === 'open') { try { ms.endOfStream() } catch { /* already closing: nothing left to end */ } }
    ms = null
    if (url) { URL.revokeObjectURL(url); url = '' }
  }

  /** New MediaSource for a new stream; gain 0 hides the cut until the new stream plays. */
  function open(): void {
    if (!ctx || !gain) return
    if (!el) {
      el = new Audio()
      el.addEventListener('playing', () => { if (running) set('playing') })
      el.addEventListener('error', () => { if (running) fail(TEXT.failed) })
      source = ctx.createMediaElementSource(el)
      source.connect(gain)
    }
    const mine = new MediaSource()
    ms = mine
    url = URL.createObjectURL(mine)
    el.src = url
    gain.gain.setValueAtTime(0, ctx.currentTime)
    mine.addEventListener('sourceopen', () => {
      if (mine !== ms || sb) return
      try {
        sb = mine.addSourceBuffer(AUDIO_MIME)
      } catch (e) { fail(`${TEXT.failed} (${errText(e)})`); return }
      sb.addEventListener('updateend', onUpdateEnd)
      pump()
    })
  }

  function onUpdateEnd(): void {
    if (!sb || !el) return
    if (sb.buffered.length > 0) {
      const start = sb.buffered.start(0), end = sb.buffered.end(sb.buffered.length - 1)
      if (el.paused) {
        if (end - start >= JITTER_S) {
          el.currentTime = Math.max(start, end - JITTER_S)
          void el.play().then(() => { if (ctx && gain) gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_S) }, () => { if (running) fail(TEXT.blocked) })
        }
      } else if (end - el.currentTime > LIVE_JUMP_S) {
        el.currentTime = end - JITTER_S // too far behind: skip to live (the skipped audio is stale anyway)
      } else if (el.currentTime < start) el.currentTime = start
    }
    pump()
  }

  /** Append the next queued chunk, or trim old audio when idle. One operation at a time (`updating`). */
  function pump(): void {
    if (!sb || !el || sb.updating) return
    const next = queue.shift()
    if (next) {
      try {
        sb.appendBuffer(next as BufferSource as ArrayBuffer)
        quotaRetries = 0
      } catch (e) {
        if (e instanceof Error && e.name === 'QuotaExceededError' && quotaRetries++ < MAX_QUOTA_RETRIES && sb.buffered.length > 0) {
          queue.unshift(next) // keep the chunk; free played audio, onUpdateEnd retries
          sb.remove(sb.buffered.start(0), Math.max(el.currentTime, sb.buffered.start(0) + 0.001))
        } else fail(`${TEXT.failed} (${e instanceof Error ? e.name : 'append'})`)
      }
      return
    }
    if (sb.buffered.length > 0 && el.currentTime - sb.buffered.start(0) > KEEP_BEHIND_S) sb.remove(sb.buffered.start(0), el.currentTime - KEEP_BEHIND_S / 2)
  }

  return {
    start() {
      if (!audioSupported()) { set('unsupported', TEXT.unsupported); return }
      try {
        ctx ??= new AudioContext()
        if (!gain) { gain = ctx.createGain(); gain.connect(ctx.destination) }
        void ctx.resume()
      } catch (e) { fail(`${TEXT.failed} (${errText(e)})`); return }
      running = true
      set('connecting')
      if (!ms) open()
    },
    push(c) {
      if (!running) return
      if (c.streamKey !== key) {
        if (c.seq !== 0) return // joined mid-stream without its header: the server replays seq 0 first, wait for it
        if (key !== '') { teardown(); running = true; open() } // another stream: full reset
        key = c.streamKey
      } else if (key === '') return
      queue.push(c.payload)
      pump()
    },
    stop() {
      teardown()
      set('idle')
    },
    dispose() {
      teardown()
      source?.disconnect(); gain?.disconnect()
      source = null; gain = null; el = null
      void ctx?.close()
      ctx = null
      set('idle')
    },
    get: () => view,
  }
}
