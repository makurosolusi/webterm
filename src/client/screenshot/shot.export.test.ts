/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { copyImage, saveImage, shotFileName, REVOKE_DELAY_MS } from './shot.export'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })
const blob = new Blob(['x'], { type: 'image/png' })

describe('shot export', () => {
  test('file name is webterm-YYYYMMDD-HHmmss.png in local time', () => {
    expect(shotFileName(new Date(2026, 10, 5, 7, 8, 9))).toBe('webterm-20261105-070809.png')
  })
  test('copy: ok writes an image/png ClipboardItem', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    class Item { constructor(public data: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', Item)
    vi.stubGlobal('navigator', { clipboard: { write } })
    expect(await copyImage(blob)).toBe('ok')
    expect((write.mock.calls[0][0][0] as Item).data['image/png']).toBe(blob)
  })
  test('copy: unsupported without ClipboardItem or clipboard.write', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } })
    expect(await copyImage(blob)).toBe('unsupported')
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', {})
    expect(await copyImage(blob)).toBe('unsupported')
  })
  test('copy: NotAllowedError is denied, anything else failed', async () => {
    vi.stubGlobal('ClipboardItem', class {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')) } })
    expect(await copyImage(blob)).toBe('denied')
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new Error('boom')) } })
    expect(await copyImage(blob)).toBe('failed')
  })
  test('save: download anchor, no navigation, URL revoked later', () => {
    vi.useFakeTimers()
    const create = vi.fn().mockReturnValue('blob:x'), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('a.png'); expect(this.href).toBe('blob:x'); expect(this.target).toBe('')
    })
    saveImage(blob, 'a.png')
    expect(click).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revoke).toHaveBeenCalledWith('blob:x')
    expect(document.querySelector('a[download]')).toBeNull()
  })
})
