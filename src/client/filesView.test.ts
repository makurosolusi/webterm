import { describe, expect, it } from 'vitest'
import { applyView, DEFAULT_VIEW, isAuthFail, needsMeta, relativePath, viewOf } from './filesView'

const e = (name: string, dir = false, size?: number, mtimeMs?: number) => ({ name, dir, size, mtimeMs })
const names = (xs: { name: string }[]) => xs.map((x) => x.name)

describe('applyView', () => {
  const list = [e('src', true), e('.git', true), e('a.txt', false, 5, 30), e('.env', false, 1, 10), e('b10', false, 50, 20), e('b2', false, 7, 40)]

  it('default mempertahankan urutan server dan menampilkan dotfile', () => {
    expect(names(applyView(list, DEFAULT_VIEW))).toEqual(names(list))
  })

  it('hidden:true membuang dotfile', () => {
    expect(names(applyView(list, { ...DEFAULT_VIEW, hidden: true }))).toEqual(['src', 'a.txt', 'b10', 'b2'])
  })

  it('nama turun: folder tetap di atas, natural numeric (b2 < b10)', () => {
    expect(names(applyView(list, { hidden: true, sortKey: 'name', sortDir: 'desc' }))).toEqual(['src', 'b10', 'b2', 'a.txt'])
  })

  it('ukuran: file diurut ukuran, folder tetap di atas dengan urutan nama', () => {
    const out = names(applyView(list, { hidden: true, sortKey: 'size', sortDir: 'asc' }))
    expect(out).toEqual(['src', 'a.txt', 'b2', 'b10'])
    expect(names(applyView(list, { hidden: true, sortKey: 'size', sortDir: 'desc' }))).toEqual(['src', 'b10', 'b2', 'a.txt'])
  })

  it('mtime turun: yang terbaru dulu; tidak mengubah array masukan', () => {
    const copy = [...list]
    expect(names(applyView(list, { hidden: true, sortKey: 'mtime', sortDir: 'desc' }))).toEqual(['src', 'b2', 'a.txt', 'b10'])
    expect(list).toEqual(copy)
  })

  it('ukuran sama: jatuh ke nama agar stabil', () => {
    const out = applyView([e('b', false, 1), e('a', false, 1)], { hidden: false, sortKey: 'size', sortDir: 'asc' })
    expect(names(out)).toEqual(['a', 'b'])
  })
})

describe('viewOf / needsMeta', () => {
  it('viewOpts absen = default; hanya urutan selain nama butuh metadata', () => {
    expect(viewOf(undefined)).toBe(DEFAULT_VIEW)
    expect(needsMeta(DEFAULT_VIEW)).toBe(false)
    expect(needsMeta({ ...DEFAULT_VIEW, sortKey: 'size' })).toBe(true)
    expect(needsMeta({ ...DEFAULT_VIEW, sortKey: 'name', sortDir: 'desc' })).toBe(false)
  })
})

describe('relativePath', () => {
  it('relatif di dalam akar, "." untuk akar, absolut di luar akar', () => {
    expect(relativePath('/p', '/p/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/p/', '/p/a')).toBe('a')
    expect(relativePath('/p', '/p')).toBe('.')
    expect(relativePath('/p', '/other/a')).toBe('/other/a')
    expect(relativePath('/p', '/pp/a')).toBe('/pp/a')
  })
})

describe('isAuthFail', () => {
  it('hanya EIO dengan "HTTP 401" — bukan 5xx dan bukan kode lain', () => {
    expect(isAuthFail({ code: 'EIO', error: 'HTTP 401' })).toBe(true)
    expect(isAuthFail({ code: 'EIO', error: 'list failed: HTTP 401 Unauthorized' })).toBe(true)
    expect(isAuthFail({ code: 'EIO', error: 'HTTP 4011' })).toBe(false)
    expect(isAuthFail({ code: 'EIO', error: 'HTTP 502' })).toBe(false)
    expect(isAuthFail({ code: 'EACCES', error: 'HTTP 401' })).toBe(false)
  })
})
