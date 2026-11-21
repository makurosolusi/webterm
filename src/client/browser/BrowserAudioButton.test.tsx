/** @vitest-environment jsdom */
// Speaker button + hook with a fake player and a fake stream (no real audio).
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioChunk } from '../../shared/browser.contract'
import type { BrowserStream } from '../browser.stream'
import type { AudioPlayerView } from './browserAudio.player'

const h = vi.hoisted(() => ({ supported: true, players: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; push: ReturnType<typeof vi.fn>; emit: (v: AudioPlayerView) => void }> }))
vi.mock('./browserAudio.player', () => ({
  audioSupported: () => h.supported,
  TEXT: { unsupported: 'Not supported here.', blocked: 'Click anywhere to start sound (test).' },
  createAudioPlayer: (onChange: (v: AudioPlayerView) => void) => {
    let view: AudioPlayerView = { state: 'idle', message: '' }
    const p = {
      start: vi.fn(() => { view = h.supported ? { state: 'connecting', message: '' } : { state: 'unsupported', message: 'Not supported here.' }; onChange(view) }),
      stop: vi.fn(() => { view = { state: 'idle', message: '' }; onChange(view) }),
      dispose: vi.fn(), push: vi.fn(), get: () => view,
      emit: (v: AudioPlayerView) => { view = v; onChange(v) },
    }
    h.players.push(p)
    return p
  },
}))
const { default: BrowserAudioButton, audioOffered, audioDefaultOn } = await import('./BrowserAudioButton')
const { useBrowserAudio } = await import('./browserAudio.use')

const makeStream = () => ({ setAudio: vi.fn() }) as unknown as BrowserStream & { setAudio: ReturnType<typeof vi.fn> }
let sinkRef: { current: ((c: AudioChunk) => void) | null }
interface HarnessProps { stream: BrowserStream; paused?: boolean; offered?: boolean; saved?: boolean; defaultOn?: boolean; persist?: (on: boolean) => void; active?: boolean }
function Harness({ stream, paused = false, offered = true, saved, defaultOn = true, persist = () => {}, active }: HarnessProps) {
  const sink = useRef<((c: AudioChunk) => void) | null>(null)
  sinkRef = sink
  const audio = useBrowserAudio('n', stream, sink, { paused, offered, saved, defaultOn, persist })
  return <BrowserAudioButton audio={audio} active={active} />
}

beforeEach(() => { h.supported = true; h.players.length = 0 })
afterEach(cleanup)

const chunk = { nodeId: 'n', streamKey: 'a', seq: 0, t: 0, payload: new Uint8Array(1) }
const playing = () => act(() => h.players[0].emit({ state: 'playing', message: '' }))

describe('BrowserAudioButton: default on', () => {
  it('auto-starts with no click: one player started, audio on sent, button says Mute and is pressed', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} persist={persist} />)
    expect(h.players).toHaveLength(1)
    expect(h.players[0].start).toHaveBeenCalled()
    expect(stream.setAudio).toHaveBeenCalledWith('n', true)
    expect(persist).not.toHaveBeenCalled() // nothing is saved until the user chooses
    playing()
    const b = screen.getByRole('button', { name: 'Mute browser audio' })
    expect(b.getAttribute('aria-pressed')).toBe('true')
    expect(b.querySelector('.codicon-unmute')).toBeTruthy()
  })

  it('muted by the user earlier (layout false): nothing starts, label Unmute, slashed speaker, not pressed', () => {
    const stream = makeStream()
    render(<Harness stream={stream} saved={false} />)
    const b = screen.getByRole('button', { name: 'Unmute browser audio' })
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(b.querySelector('.codicon-mute')).toBeTruthy()
    expect(h.players).toHaveLength(0)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', true)
  })

  it('click while on = mute: audio off, player stopped, saved as false; click again = unmute, saved as true, same player', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} persist={persist} />)
    playing()
    fireEvent.click(screen.getByRole('button'))
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', false)
    expect(h.players[0].stop).toHaveBeenCalled()
    expect(persist).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole('button', { name: 'Unmute browser audio' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button'))
    expect(persist).toHaveBeenLastCalledWith(true)
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', true)
    expect(h.players).toHaveLength(1)
  })

  it('unmute from a saved mute starts the player inside the click', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} saved={false} persist={persist} />)
    fireEvent.click(screen.getByRole('button'))
    expect(h.players).toHaveLength(1)
    expect(h.players[0].start).toHaveBeenCalled()
    expect(persist).toHaveBeenCalledWith(true)
  })

  it('server kill switch (offered=false): nothing starts', () => {
    const stream = makeStream()
    render(<Harness stream={stream} offered={false} />)
    expect(h.players).toHaveLength(0)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', true)
  })

  it('unmount sends audio off and disposes the player', () => {
    const stream = makeStream()
    const { unmount } = render(<Harness stream={stream} />)
    unmount()
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', false)
    expect(h.players[0].dispose).toHaveBeenCalled()
  })

  it('chunks from the session sink reach the player', () => {
    render(<Harness stream={makeStream()} />)
    sinkRef.current?.(chunk)
    expect(h.players[0].push).toHaveBeenCalledWith(chunk)
  })

  it('a hidden node stops playback (intent stays on, no audio off, no save) and restarts when shown again with no gesture', () => {
    const stream = makeStream(), persist = vi.fn()
    const { rerender } = render(<Harness stream={stream} persist={persist} />)
    rerender(<Harness stream={stream} persist={persist} paused />)
    expect(h.players[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', false)
    rerender(<Harness stream={stream} persist={persist} paused={false} />)
    expect(h.players[0].start).toHaveBeenCalledTimes(2)
    expect(persist).not.toHaveBeenCalled()
  })

  it('a muted node that is hidden and shown again stays silent', () => {
    const stream = makeStream()
    const { rerender } = render(<Harness stream={stream} saved={false} />)
    rerender(<Harness stream={stream} saved={false} paused />)
    rerender(<Harness stream={stream} saved={false} paused={false} />)
    expect(h.players).toHaveLength(0)
  })

  it('unsupported: disabled with the reason as accessible description, no audio on, click does nothing', () => {
    h.supported = false
    const stream = makeStream()
    render(<Harness stream={stream} />)
    const b = screen.getByRole('button') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-label')).toBe('Browser audio unavailable')
    expect(document.getElementById(b.getAttribute('aria-describedby')!)?.textContent).toBe('Not supported here.')
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', true)
    fireEvent.click(b)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', true)
  })

  it('error: offers Try again with the message described, and the click restarts', () => {
    const stream = makeStream()
    render(<Harness stream={stream} />)
    act(() => h.players[0].emit({ state: 'error', message: 'Audio playback failed.' }))
    const b = screen.getByRole('button', { name: 'Audio failed. Try again' })
    expect(document.getElementById(b.getAttribute('aria-describedby')!)?.textContent).toBe('Audio playback failed.')
    const before = h.players[0].start.mock.calls.length
    fireEvent.click(b)
    expect(h.players[0].start.mock.calls.length).toBe(before + 1)
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', true)
  })

  it('activity dot only while muted', () => {
    const { unmount } = render(<Harness stream={makeStream()} active />)
    expect(screen.queryByRole('img')).toBeNull() // on: the sound itself is the signal
    unmount()
    render(<Harness stream={makeStream()} active saved={false} />)
    expect(screen.getByRole('img', { name: 'This page is making sound' })).toBeTruthy()
  })

  it('capability: shown unless the server says audio:false', () => {
    expect(audioOffered({ audio: false })).toBe(false)
    expect(audioOffered({ audio: true })).toBe(true)
    expect(audioOffered({})).toBe(true)
    expect(audioOffered(null)).toBe(true)
  })
})

describe('Settings default (WEBTERM_BROWSER_AUDIO_DEFAULT) with three saved states', () => {
  it('never chosen + default on: auto-starts', () => {
    const stream = makeStream()
    render(<Harness stream={stream} saved={undefined} defaultOn />)
    expect(stream.setAudio).toHaveBeenCalledWith('n', true)
  })

  it('never chosen + default off: nothing starts, the button says Unmute, and the click saves an explicit true', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} defaultOn={false} persist={persist} />)
    expect(h.players).toHaveLength(0)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', true)
    fireEvent.click(screen.getByRole('button', { name: 'Unmute browser audio' }))
    expect(h.players[0].start).toHaveBeenCalled()
    expect(persist).toHaveBeenCalledWith(true)
  })

  it('explicit true + default off: starts', () => {
    const stream = makeStream()
    render(<Harness stream={stream} saved defaultOn={false} />)
    expect(stream.setAudio).toHaveBeenCalledWith('n', true)
  })

  it('explicit false + default on: does not start', () => {
    const stream = makeStream()
    render(<Harness stream={stream} saved={false} defaultOn />)
    expect(h.players).toHaveLength(0)
  })

  it('default changing while shown: a never-chosen node follows, explicit nodes do not', () => {
    const a = makeStream(), b = makeStream(), c = makeStream()
    const ra = render(<Harness stream={a} defaultOn />)
    const rb = render(<Harness stream={b} saved defaultOn />)
    const rc = render(<Harness stream={c} saved={false} defaultOn />)
    ra.rerender(<Harness stream={a} defaultOn={false} />)
    rb.rerender(<Harness stream={b} saved defaultOn={false} />)
    rc.rerender(<Harness stream={c} saved={false} defaultOn={false} />)
    expect(a.setAudio).toHaveBeenLastCalledWith('n', false) // followed: stopped
    expect(b.setAudio).not.toHaveBeenCalledWith('n', false) // explicit on stays on
    expect(c.setAudio).not.toHaveBeenCalledWith('n', true) // explicit mute stays muted
    ra.rerender(<Harness stream={a} defaultOn />)
    expect(a.setAudio).toHaveBeenLastCalledWith('n', true)
  })

  it('status to default: on unless the server says false; unknown status = not on yet', () => {
    expect(audioDefaultOn({ audioDefault: true })).toBe(true)
    expect(audioDefaultOn({ audioDefault: false })).toBe(false)
    expect(audioDefaultOn({})).toBe(true) // older server
    expect(audioDefaultOn(null)).toBe(false)
  })
})

describe('blocked by the autoplay policy', () => {
  const blockPlayer = () => act(() => h.players[0].emit({ state: 'blocked', message: 'Click anywhere to start sound' }))

  it('shows an honest label, still pressed, data-state blocked', () => {
    render(<Harness stream={makeStream()} />)
    blockPlayer()
    const b = screen.getByRole('button', { name: /Click anywhere to start sound/ })
    expect(b.getAttribute('aria-pressed')).toBe('true')
    expect(b.getAttribute('data-state')).toBe('blocked')
  })

  it('the first pointerdown anywhere restarts the player (inside the gesture) and the listener is one-shot', () => {
    render(<Harness stream={makeStream()} />)
    blockPlayer()
    const before = h.players[0].start.mock.calls.length
    fireEvent.pointerDown(document.body)
    expect(h.players[0].start.mock.calls.length).toBe(before + 1)
    fireEvent.pointerDown(document.body)
    expect(h.players[0].start.mock.calls.length).toBe(before + 1)
  })

  it('a keydown also counts as the gesture', () => {
    render(<Harness stream={makeStream()} />)
    blockPlayer()
    const before = h.players[0].start.mock.calls.length
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(h.players[0].start.mock.calls.length).toBe(before + 1)
  })

  it('no listener while playing or hidden; removed when hidden and on unmount', () => {
    const spy = vi.spyOn(document, 'addEventListener')
    const rm = vi.spyOn(document, 'removeEventListener')
    const gestureAdds = () => spy.mock.calls.filter(([t]) => t === 'pointerdown').length
    const stream = makeStream()
    const { rerender, unmount } = render(<Harness stream={stream} />)
    playing()
    expect(gestureAdds()).toBe(0)
    blockPlayer()
    expect(gestureAdds()).toBe(1)
    rerender(<Harness stream={stream} paused />) // hidden: listener removed
    expect(rm.mock.calls.some(([t]) => t === 'pointerdown')).toBe(true)
    rerender(<Harness stream={stream} />)
    blockPlayer()
    const removed = rm.mock.calls.filter(([t]) => t === 'pointerdown').length
    unmount() // blocked again, then unmounted: the listener goes away with it
    expect(rm.mock.calls.filter(([t]) => t === 'pointerdown').length).toBeGreaterThan(removed)
    spy.mockRestore(); rm.mockRestore()
  })

  it('clicking the button while blocked unblocks instead of muting', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} persist={persist} />)
    blockPlayer()
    const before = h.players[0].start.mock.calls.length
    fireEvent.click(screen.getByRole('button'))
    expect(h.players[0].start.mock.calls.length).toBe(before + 1)
    expect(persist).not.toHaveBeenCalled()
  })

  it('leaving blocked (it started playing) removes the listener', () => {
    render(<Harness stream={makeStream()} />)
    blockPlayer()
    act(() => h.players[0].emit({ state: 'playing', message: '' }))
    const before = h.players[0].start.mock.calls.length
    fireEvent.pointerDown(document.body)
    expect(h.players[0].start.mock.calls.length).toBe(before)
  })
})
