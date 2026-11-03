import { describe, expect, it } from 'vitest'
import {
  EMPTY_SEL, selectAll, selectedNames, selectOne, selectRange, toggleName,
} from './filesSelection'

const es = ['a', 'b', 'c', 'd', 'é'].map((name) => ({ name, dir: false }))
const set = (s: { names: ReadonlySet<string> }) => [...s.names].sort()

describe('seleksi multi', () => {
  it('selectOne mengisi anchor dan kursor; null mengosongkan', () => {
    expect(selectOne('b')).toEqual({ names: new Set(['b']), anchor: 'b', cursor: 'b' })
    expect(selectOne(null)).toBe(EMPTY_SEL)
  })

  it('toggleName menambah/membuang dan memindahkan anchor', () => {
    const s1 = toggleName(selectOne('a'), 'c')
    expect(set(s1)).toEqual(['a', 'c'])
    expect(s1.anchor).toBe('c')
    expect(set(toggleName(s1, 'a'))).toEqual(['c'])
  })

  it('selectRange mengambil rentang anchor..indeks dua arah, anchor tetap', () => {
    const base = selectOne('b')
    expect(set(selectRange(base, es, 3))).toEqual(['b', 'c', 'd'])
    const up = selectRange(base, es, 0)
    expect(set(up)).toEqual(['a', 'b'])
    expect(up.anchor).toBe('b')
    expect(up.cursor).toBe('a')
    // memperpendek rentang melepas baris di luar rentang baru
    expect(set(selectRange(selectRange(base, es, 3), es, 2))).toEqual(['b', 'c'])
  })

  it('selectRange tanpa anchor jatuh ke pilihan tunggal; indeks di luar = tak berubah', () => {
    expect(set(selectRange(EMPTY_SEL, es, 2))).toEqual(['c'])
    const s = selectOne('a')
    expect(selectRange(s, es, 99)).toBe(s)
  })

  it('selectAll memilih semua, mempertahankan kursor yang masih ada', () => {
    const all = selectAll(selectOne('c'), es)
    expect(all.names.size).toBe(5)
    expect(all.cursor).toBe('c')
    expect(selectAll(EMPTY_SEL, []).names.size).toBe(0)
  })

  it('NFC: nama NFD dan NFC adalah satu entri; selectedNames memberi nama asli berurutan tampil', () => {
    const nfd = 'é'
    const s = toggleName(selectOne('a'), nfd)
    expect(s.names.has('é')).toBe(true)
    expect(selectedNames(es, s)).toEqual(['a', 'é'])
  })
})
