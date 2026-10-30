/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from './clipboard'

function stubClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

/** jsdom tidak punya `execCommand`; stub merekam isi textarea pada saat copy. */
function stubExecCommand(result: boolean): { copied: string[] } {
  const rec = { copied: [] as string[] }
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn((cmd: string) => {
      const ta = document.querySelector('textarea')
      if (cmd === 'copy' && ta) rec.copied.push(ta.value)
      return result
    }),
  })
  return rec
}

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error -- dibersihkan supaya test berikutnya mulai tanpa clipboard
  delete navigator.clipboard
  // @ts-expect-error -- idem
  delete document.execCommand
})

describe('writeClipboard', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    const exec = stubExecCommand(true)

    await expect(writeClipboard('halo')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('halo')
    expect(exec.copied).toEqual([])
  })

  it('falls back to a hidden textarea + execCommand when the API is missing', async () => {
    expect(navigator.clipboard).toBeUndefined()
    const exec = stubExecCommand(true)

    await expect(writeClipboard('baris1\nbaris2')).resolves.toBe(true)

    expect(exec.copied).toEqual(['baris1\nbaris2'])
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back when writeText rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const exec = stubExecCommand(true)

    await expect(writeClipboard('x')).resolves.toBe(true)

    expect(exec.copied).toEqual(['x'])
  })

  it('reports false when the API rejects and the fallback fails too, and cleans up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    stubExecCommand(false)

    await expect(writeClipboard('x')).resolves.toBe(false)

    expect(document.querySelector('textarea')).toBeNull()
  })

  it('restores focus to the previously focused element after the fallback', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    stubExecCommand(true)

    await writeClipboard('x')

    expect(document.activeElement).toBe(input)
    input.remove()
  })
})
