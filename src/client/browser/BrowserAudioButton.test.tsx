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
  TEXT: { unsupported: 'Not supported here.' },
  createAudioPlayer: (onChange: (v: AudioPlayerView) => void) => {
    let view: AudioPlayerView = { state: 'idle', message: '' }
    const p = {
      start: vi.fn(() => { view = { state: 'connecting', message: '' }; onChange(view) }),
      stop: vi.fn(() => { view = { state: 'idle', message: '' }; onChange(view) }),
      dispose: vi.fn(), push: vi.fn(), get: () => view,
      emit: (v: AudioPlayerView) => { view = v; onChange(v) },
    }
    h.players.push(p)
    return p
  },
}))
const { default: BrowserAudioButton, audioOffered } = await import('./BrowserAudioButton')
const { useBrowserAudio } = await import('./browserAudio.use')

const makeStream = () => ({ setAudio: vi.fn() }) as unknown as BrowserStream & { setAudio: ReturnType<typeof vi.fn> }
let sinkRef: { current: ((c: AudioChunk) => void) | null }
function Harness({ stream, paused = false, persist = () => {}, active }: { stream: BrowserStream; paused?: boolean; persist?: (on: boolean) => void; active?: boolean }) {
  const sink = useRef<((c: AudioChunk) => void) | null>(null)
  sinkRef = sink
  const audio = useBrowserAudio('n', stream, sink, paused, persist)
  return <BrowserAudioButton audio={audio} active={active} />
}

beforeEach(() => { h.supported = true; h.players.length = 0 })
afterEach(cleanup)

describe('BrowserAudioButton', () => {
  it('starts muted: labelled, not pressed, nothing sent, no player yet', () => {
    const stream = makeStream()
    render(<Harness stream={stream} />)
    const b = screen.getByRole('button', { name: 'Play browser audio' })
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(stream.setAudio).not.toHaveBeenCalled()
    expect(h.players).toHaveLength(0)
  })

  it('click = gesture: starts the player once, sends audio on, persists, then pressed', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} persist={persist} />)
    fireEvent.click(screen.getByRole('button'))
    expect(h.players).toHaveLength(1)
    expect(h.players[0].start).toHaveBeenCalledTimes(1)
    expect(stream.setAudio).toHaveBeenCalledWith('n', true)
    expect(persist).toHaveBeenCalledWith(true)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
    act(() => h.players[0].emit({ state: 'playing', message: '' }))
    expect(screen.getByRole('button', { name: 'Mute browser audio' })).toBeTruthy()
  })

  it('second click mutes: audio off, player stopped, persisted off; unmuting again reuses the one player', () => {
    const stream = makeStream(), persist = vi.fn()
    render(<Harness stream={stream} persist={persist} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', false)
    expect(h.players[0].stop).toHaveBeenCalled()
    expect(persist).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button'))
    expect(h.players).toHaveLength(1)
  })

  it('unmount sends audio off and disposes the player', () => {
    const stream = makeStream()
    const { unmount } = render(<Harness stream={stream} />)
    fireEvent.click(screen.getByRole('button'))
    unmount()
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', false)
    expect(h.players[0].dispose).toHaveBeenCalled()
  })

  it('chunks from the session sink reach the player', () => {
    render(<Harness stream={makeStream()} />)
    fireEvent.click(screen.getByRole('button'))
    const c = { nodeId: 'n', streamKey: 'a', seq: 0, t: 0, payload: new Uint8Array(1) }
    sinkRef.current?.(c)
    expect(h.players[0].push).toHaveBeenCalledWith(c)
  })

  it('a hidden node stops playback and resumes it (no new gesture) when shown again; intent stays on', () => {
    const stream = makeStream()
    const { rerender } = render(<Harness stream={stream} />)
    fireEvent.click(screen.getByRole('button'))
    rerender(<Harness stream={stream} paused />)
    expect(h.players[0].stop).toHaveBeenCalledTimes(1)
    expect(stream.setAudio).not.toHaveBeenCalledWith('n', false)
    rerender(<Harness stream={stream} paused={false} />)
    expect(h.players[0].start).toHaveBeenCalledTimes(2)
  })

  it('unsupported: disabled with the reason as accessible description, and a click does nothing', () => {
    h.supported = false
    const stream = makeStream()
    render(<Harness stream={stream} />)
    const b = screen.getByRole('button') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-label')).toBe('Browser audio unavailable')
    expect(document.getElementById(b.getAttribute('aria-describedby')!)?.textContent).toBe('Not supported here.')
    fireEvent.click(b)
    expect(stream.setAudio).not.toHaveBeenCalled()
  })

  it('error: offers Try again with the message described, and the click restarts', () => {
    const stream = makeStream()
    render(<Harness stream={stream} />)
    fireEvent.click(screen.getByRole('button'))
    act(() => h.players[0].emit({ state: 'error', message: 'Audio playback failed.' }))
    const b = screen.getByRole('button', { name: 'Audio failed. Try again' })
    expect(document.getElementById(b.getAttribute('aria-describedby')!)?.textContent).toBe('Audio playback failed.')
    fireEvent.click(b)
    expect(h.players[0].start).toHaveBeenCalledTimes(2)
    expect(stream.setAudio).toHaveBeenLastCalledWith('n', true)
  })

  it('activity dot only while muted', () => {
    render(<Harness stream={makeStream()} active />)
    expect(screen.getByRole('img', { name: 'This page is making sound' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('capability: shown unless the server says audio:false', () => {
    expect(audioOffered({ audio: false })).toBe(false)
    expect(audioOffered({ audio: true })).toBe(true)
    expect(audioOffered({})).toBe(true)
    expect(audioOffered(null)).toBe(true)
  })
})
