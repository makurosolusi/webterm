/**
 * @vitest-environment jsdom
 */
// Viewer states and actions: meta reporting, Retry, Open as Text, capability failure, PDF loading.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsCapabilities } from '../../shared/fsContract'

const caps: FsCapabilities = { mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }
const h = vi.hoisted(() => ({ capsFail: 0 }))
vi.mock('../fsClient', () => ({
  capabilities: () => (h.capsFail-- > 0 ? Promise.reject(new Error('offline')) : Promise.resolve(caps)),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}&token=t`,
  stat: () => Promise.resolve({ ok: true, version: '1-2048', meta: { name: 'x', dir: false, ignored: false, size: 2048 } }),
}))
vi.mock('../clipboard', () => ({ writeClipboard: () => Promise.resolve(true) }))

import { ViewerHost } from './ViewerHost'

beforeEach(() => { h.capsFail = 0; vi.spyOn(console, 'warn').mockImplementation(() => undefined) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const loadImg = (img: HTMLElement, w: number, hgt: number) => {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: hgt, configurable: true })
  fireEvent.load(img)
}

describe('ViewerHost states', () => {
  it('reports image dimensions and file size through onMeta', async () => {
    const onMeta = vi.fn()
    render(<ViewerHost path="/a/pic.png" kind="image" onMeta={onMeta} />)
    await waitFor(() => expect(onMeta).toHaveBeenLastCalledWith({ bytes: 2048 }))
    loadImg(await screen.findByRole('img'), 1920, 1080)
    expect(onMeta).toHaveBeenLastCalledWith({ width: 1920, height: 1080, bytes: 2048 })
  })

  it('reports video frame size once metadata loads', async () => {
    const onMeta = vi.fn()
    const { container } = render(<ViewerHost path="/a/v.mp4" kind="video" onMeta={onMeta} />)
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const v = container.querySelector('video')!
    expect(v.parentElement!.classList.contains('nodrag')).toBe(true)
    Object.defineProperty(v, 'videoWidth', { value: 640 })
    Object.defineProperty(v, 'videoHeight', { value: 360 })
    fireEvent.loadedMetadata(v)
    await waitFor(() => expect(onMeta).toHaveBeenLastCalledWith({ width: 640, height: 360, bytes: 2048 }))
  })

  it('a failed load offers Retry, which mounts the viewer again', async () => {
    const { container } = render(<ViewerHost path="/a/pic.png" kind="image" />)
    fireEvent.error(await screen.findByRole('img'))
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to load')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(screen.queryByText('Failed to load')).toBeNull()
  })

  it('a failed capability check shows an error with Retry instead of loading forever', async () => {
    h.capsFail = 1
    render(<ViewerHost path="/a/pic.png" kind="image" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t check which previews are available.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('img')).toBeTruthy()
  })

  it('SVG offers Open as Text; a raster image does not', async () => {
    const onOpenAsText = vi.fn()
    const { rerender } = render(<ViewerHost path="/a/logo.svg" kind="image" onOpenAsText={onOpenAsText} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open as Text' }))
    expect(onOpenAsText).toHaveBeenCalledTimes(1)
    rerender(<ViewerHost path="/a/pic.png" kind="image" onOpenAsText={onOpenAsText} />)
    await screen.findByRole('img')
    expect(screen.queryByRole('button', { name: 'Open as Text' })).toBeNull()
  })

  it('a binary placeholder offers Open as Text; an archive does not', async () => {
    const onOpenAsText = vi.fn()
    const { rerender } = render(<ViewerHost path="/a/data.bin" kind="binary" onOpenAsText={onOpenAsText} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open as Text' }))
    expect(onOpenAsText).toHaveBeenCalledTimes(1)
    rerender(<ViewerHost path="/a/b.zip" kind="archive" onOpenAsText={onOpenAsText} />)
    await screen.findByText('b.zip')
    expect(screen.queryByRole('button', { name: 'Open as Text' })).toBeNull()
  })

  it('pdf shows Loading… until the frame loads', async () => {
    const { container } = render(<ViewerHost path="/a/d.pdf" kind="pdf" />)
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    act(() => { fireEvent.load(container.querySelector('iframe')!) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
