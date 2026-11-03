import { describe, expect, it } from 'vitest'
import { urlFromDrop } from './browser.dropUrl'

const dt = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' })

describe('urlFromDrop', () => {
  it('melewati komentar # dan memakai baris pertama uri-list', () => {
    expect(urlFromDrop(dt({ 'text/uri-list': '# komentar\r\nhttps://example.com/a\r\nhttps://lain.test/' }))).toBe('https://example.com/a')
  })
  it('jatuh ke text/plain ber-spasi bila uri-list kosong', () => {
    expect(urlFromDrop(dt({ 'text/plain': '  https://example.com/x  ' }))).toBe('https://example.com/x')
  })
  it('teks bukan URL -> null', () => {
    expect(urlFromDrop(dt({ 'text/plain': 'halo dunia' }))).toBeNull()
  })
  it('skema file: dan javascript: -> null', () => {
    expect(urlFromDrop(dt({ 'text/uri-list': 'file:///etc/passwd' }))).toBeNull()
    expect(urlFromDrop(dt({ 'text/plain': 'javascript:alert(1)' }))).toBeNull()
  })
  it('URL dengan userinfo -> null', () => {
    expect(urlFromDrop(dt({ 'text/plain': 'https://u:p@example.com/' }))).toBeNull()
  })
  it('hanya files (tanpa teks) -> null', () => {
    expect(urlFromDrop(dt({}))).toBeNull()
  })
})
