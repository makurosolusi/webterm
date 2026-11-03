import { describe, expect, it, vi } from 'vitest'
import { linkRows, openableLink } from './terminalLinks'

const OK = { status: 'created', nodeId: 'b1' } as const

describe('openableLink', () => {
  it('url http(s) valid lolos', () => {
    expect(openableLink('https://example.com/x')).toBe('https://example.com/x')
  })
  it.each([[null], [''], ['ftp://example.com'], ['file:///etc/passwd'], ['javascript:alert(1)']])('%s ditolak', (raw) => {
    expect(openableLink(raw)).toBeNull()
  })
})

describe('linkRows', () => {
  it('open undefined (flag mati) -> tanpa baris', () => {
    expect(linkRows('https://example.com', 'n1', undefined)).toEqual([])
  })
  it('link kosong/tak valid -> tanpa baris', () => {
    const open = vi.fn(() => OK)
    expect(linkRows(null, 'n1', open)).toEqual([])
    expect(linkRows('file:///etc/passwd', 'n1', open)).toEqual([])
  })
  it('link valid -> satu baris + separator; klik memanggil open dengan url dan anchor', () => {
    const open = vi.fn(() => OK)
    const rows = linkRows('https://example.com/a', 'n1', open)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({ type: 'separator' })
    const first = rows[0]
    if ('type' in first) throw new Error('baris pertama harus item')
    expect(first.label).toBe('Open in canvas browser')
    first.onClick()
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com/a', anchorNodeId: 'n1' })
  })
})
