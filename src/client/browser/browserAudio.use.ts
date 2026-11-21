// Binds one browser node to its audio player. Sound is ON by default: while the node is shown and the server offers audio, the
// player starts by itself and tells the server to stream (`audio on`, replayed by the stream after every attach/reconnect).
// Three saved states per node: absent = follow the Settings default (`defaultOn`, from the server), true/false = the user chose. Browsers refuse sound before a user gesture in THIS tab, so a player that reports `blocked`
// is resumed by the next pointerdown/keydown anywhere; unmount, mute or a hidden node stops playback and removes the listener.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AudioChunk } from '../../shared/browser.contract'
import type { BrowserStream } from '../browser.stream'
import { createAudioPlayer } from './browserAudio.player'
import type { AudioPlayer, AudioPlayerView } from './browserAudio.player'

export interface BrowserAudio extends AudioPlayerView {
  /** True while sound is wanted (not muted by the user). */
  on: boolean
  /** Click handler: mute <-> unmute (a gesture, so it also unblocks), error -> try again. */
  toggle: () => void
}

export interface BrowserAudioOptions {
  /** The node's session is detached (hidden/collapsed/zoomed out): the server sends nothing, so playback stops until it is back. */
  paused: boolean
  /** False when the server cannot capture audio (kill switch): nothing is started. */
  offered: boolean
  /** The node's saved choice: undefined = never chosen (follows `defaultOn`), true = sound on, false = muted. */
  saved: boolean | undefined
  /** Settings default (WEBTERM_BROWSER_AUDIO_DEFAULT via /status) for nodes that never chose; follows live changes. */
  defaultOn: boolean
  /** Saves the user's explicit choice in the layout (`true` = sound on). */
  persist: (on: boolean) => void
}

const GESTURES = ['pointerdown', 'keydown'] as const

export function useBrowserAudio(id: string, stream: BrowserStream, sink: RefObject<((c: AudioChunk) => void) | null>, opts: BrowserAudioOptions): BrowserAudio {
  const { paused, offered } = opts
  const [view, setView] = useState<AudioPlayerView>({ state: 'idle', message: '' })
  const [choice, setChoice] = useState(opts.saved)
  const on = choice ?? opts.defaultOn
  const player = useRef<AudioPlayer | null>(null)
  const get = (): AudioPlayer => (player.current ??= createAudioPlayer(setView))
  const persist = useRef(opts.persist)
  persist.current = opts.persist

  useEffect(() => {
    sink.current = (c) => player.current?.push(c)
    return () => {
      sink.current = null
      stream.setAudio(id, false) // also covers close/workspace switch: the server stops capturing when nobody listens
      player.current?.dispose()
      player.current = null
    }
  }, [id, stream, sink])

  // Auto-listen: wanted + shown + offered. Cleanup (mute, hidden, unoffered) stops playback; the server detaches hidden nodes itself.
  useEffect(() => {
    if (!on || paused || !offered) return
    const p = get()
    p.start()
    if (p.get().state !== 'unsupported') stream.setAudio(id, true)
    return () => { player.current?.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `get` only reads refs/setters
  }, [on, paused, offered, id, stream])

  // Not wanted (muted, or the Settings default turned off for a never-chosen node): make sure the server does not stream to this client.
  useEffect(() => { if (!on) stream.setAudio(id, false) }, [on, id, stream])

  // Blocked by the autoplay policy: the first real interaction anywhere in this tab starts the sound (the listener is capture + once).
  const blocked = view.state === 'blocked' && on && !paused
  useEffect(() => {
    if (!blocked) return
    const resume = (): void => player.current?.start()
    for (const g of GESTURES) document.addEventListener(g, resume, { capture: true, once: true })
    return () => { for (const g of GESTURES) document.removeEventListener(g, resume, { capture: true }) }
  }, [blocked])

  const toggle = useCallback(() => {
    if (on && view.state !== 'error' && view.state !== 'blocked') {
      stream.setAudio(id, false)
      player.current?.stop()
      setChoice(false)
      persist.current(false)
      return
    }
    const p = get()
    p.start() // inside the click: creates/resumes the AudioContext
    if (p.get().state === 'unsupported') return
    stream.setAudio(id, true)
    if (!on) { setChoice(true); persist.current(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `get` only reads refs/setters
  }, [on, view.state, id, stream])

  return { ...view, on, toggle }
}
