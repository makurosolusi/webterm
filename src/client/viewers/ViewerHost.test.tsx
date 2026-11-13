/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsCapabilities } from '../../shared/fsContract'

const caps: FsCapabilities = { mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }
const h = vi.hoisted(() => ({ caps: null as unknown as FsCapabilities, capsFail: 0 }))
vi.mock('../fsClient', () => ({
  capabilities: () => (h.capsFail-- > 0 ? Promise.reject(new Error('offline')) : Promise.resolve(h.caps)),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}&token=t`,
  stat: () => Promise.resolve({ ok: true, version: '1-2048', meta: { name: 'x', dir: false, ignored: false, size: 2048 } }),
}))
const writeClipboard = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('../clipboard', () => ({ writeClipboard }))

import { ViewerHost } from './ViewerHost'

beforeEach(() => { h.caps = { ...caps }; h.capsFail = 0 })
afterEach(cleanup)

describe('ViewerHost', () => {
  it('image and SVG render as <img> with the raw URL, never an iframe', async () => {
    const { container, rerender } = render(<ViewerHost path="/a/pic.png" kind="image" />)
    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fa%2Fpic.png&token=t')
    rerender(<ViewerHost path="/a/logo.svg" kind="image" />)
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('logo.svg'))
    expect(container.querySelector('iframe, object, embed')).toBeNull()
  })

  it('version is appended to the URL so a changed file reloads', async () => {
    render(<ViewerHost path="/a/pic.png" kind="image" version="9-9" />)
    expect((await screen.findByRole('img')).getAttribute('src')).toContain('&v=9-9')
  })

  it('audio and video use native controls with preload=metadata', async () => {
    const { container, rerender } = render(<ViewerHost path="/a/s.mp3" kind="audio" />)
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
    expect(container.querySelector('audio')?.getAttribute('preload')).toBe('metadata')
    expect(container.querySelector('audio')?.hasAttribute('controls')).toBe(true)
    rerender(<ViewerHost path="/a/v.mp4" kind="video" />)
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('preload')).toBe('metadata'))
  })

  it('pdf renders a sandboxed iframe', async () => {
    const { container } = render(<ViewerHost path="/a/d.pdf" kind="pdf" />)
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(container.querySelector('iframe')?.hasAttribute('sandbox')).toBe(true)
  })

  it('flag off: non-text kinds fall back to the placeholder (no img/iframe/media)', async () => {
    h.caps = { ...caps, viewers: false }
    const { container } = render(<ViewerHost path="/a/pic.png" kind="image" />)
    expect(await screen.findByText('pic.png')).toBeTruthy()
    expect(container.querySelector('img, iframe, audio, video')).toBeNull()
  })

  it('placeholder: shows size, Download only when UPLOAD is on, Copy Path copies the path', async () => {
    render(<ViewerHost path="/a/b.zip" kind="archive" />)
    expect(await screen.findByText(/2 KB/)).toBeTruthy()
    expect(screen.queryByText('Download')).toBeNull()
    fireEvent.click(screen.getByText('Copy Path'))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('/a/b.zip'))
    cleanup()
    h.caps = { ...caps, upload: true }
    render(<ViewerHost path="/a/c.bin" kind="binary" />)
    const dl = await screen.findByText('Download')
    expect(dl.getAttribute('href')).toBe('/api/fs/raw?path=%2Fa%2Fc.bin&token=t&download=1')
  })

  it('load error calls onError once and falls back to the placeholder', async () => {
    const onError = vi.fn()
    const { container } = render(<ViewerHost path="/a/pic.png" kind="image" onError={onError} />)
    fireEvent.error(await screen.findByRole('img'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Failed to load')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('text and markdown render nothing (editor owns them)', () => {
    const a = render(<ViewerHost path="/a/x.ts" kind="text" />)
    expect(a.container.innerHTML).toBe('')
    const b = render(<ViewerHost path="/a/x.md" kind="markdown" />)
    expect(b.container.innerHTML).toBe('')
  })
})
