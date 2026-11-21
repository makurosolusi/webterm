// Binds one browser node to its audio player: the speaker click (the gesture) starts the player and tells the server to
// stream (`audio on`, replayed by the stream after every attach/reconnect); unmount or a hidden node stops both.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { AudioChunk } from '../../shared/browser.contract'
import type { BrowserStream } from '../browser.stream'
import { createAudioPlayer } from './browserAudio.player'
import type { AudioPlayer, AudioPlayerView } from './browserAudio.player'

export interface BrowserAudio extends AudioPlayerView {
  /** True while the user wants sound (button pressed). */
  on: boolean
  /** Click handler: off -> on (the gesture), on -> off, error -> try again. */
  toggle: () => void
}

/** `paused` = the node's session is detached (hidden/collapsed/zoomed out): the server sends nothing, so playback stops until it is back. */
export function useBrowserAudio(id: string, stream: BrowserStream, sink: RefObject<((c: AudioChunk) => void) | null>, paused: boolean, onPersist: (on: boolean) => void): BrowserAudio {
  const [view, setView] = useState<AudioPlayerView>({ state: 'idle', message: '' })
  const [on, setOn] = useState(false)
  const player = useRef<AudioPlayer | null>(null)
  const get = (): AudioPlayer => (player.current ??= createAudioPlayer(setView))
  const persist = useRef(onPersist)
  persist.current = onPersist

  useEffect(() => {
    sink.current = (c) => player.current?.push(c)
    return () => {
      sink.current = null
      stream.setAudio(id, false) // also covers close/workspace switch: the server stops capturing when nobody listens
      player.current?.dispose()
      player.current = null
    }
  }, [id, stream, sink])

  const wasPaused = useRef(paused)
  useEffect(() => {
    const was = wasPaused.current
    wasPaused.current = paused
    if (!on || was === paused) return
    if (paused) player.current?.stop()
    else player.current?.start() // the AudioContext already exists (created by the click), so no new gesture is needed
  }, [paused, on])

  const toggle = useCallback(() => {
    if (on && view.state !== 'error') {
      stream.setAudio(id, false)
      player.current?.stop()
      setOn(false)
      persist.current(false)
      return
    }
    const p = get()
    p.start() // inside the click: creates/resumes the AudioContext
    if (p.get().state === 'unsupported') return
    stream.setAudio(id, true)
    setOn(true)
    persist.current(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `get` only reads refs/setters
  }, [on, view.state, id, stream])

  return { ...view, on, toggle }
}
