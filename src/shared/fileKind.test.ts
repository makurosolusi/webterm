import { describe, expect, it } from 'vitest'
import { decodeStrict, fileKind, mimeOf, sniffBinary } from './fileKind'
import { SNIFF_BYTES } from './fsLimits'

describe('fileKind', () => {
  it('memetakan ekstensi ke jenis (case-insensitive, path penuh)', () => {
    const cases: [string, string][] = [
      ['a.PNG', 'image'], ['/x/y/logo.svg', 'image'], ['doc.pdf', 'pdf'], ['song.mp3', 'audio'],
      ['clip.mp4', 'video'], ['README.md', 'markdown'], ['x.zip', 'archive'], ['tool.exe', 'binary'],
      ['main.ts', 'text'], ['Makefile', 'text'], ['.gitignore', 'text'], ['noext', 'text'],
    ]
    for (const [name, kind] of cases) expect(fileKind(name), name).toBe(kind)
  })

  it('audio/video/archive BUKAN text (regresi G-03/M-05: dulu terbuka sebagai teks yang bisa disimpan)', () => {
    for (const n of ['a.mp3', 'a.wav', 'a.mp4', 'a.mov', 'a.zip', 'a.tar']) expect(fileKind(n), n).not.toBe('text')
  })

  it('sniff NUL mengubah ekstensi tak dikenal jadi binary; ekstensi dikenal tidak terpengaruh', () => {
    const withNul = new Uint8Array([104, 105, 0, 1])
    expect(fileKind('data.xyz', withNul)).toBe('binary')
    expect(fileKind('data.xyz', new Uint8Array([104, 105]))).toBe('text')
    expect(fileKind('pic.png', withNul)).toBe('image')
  })

  it('mimeOf: dikenal -> tipe, tak dikenal -> undefined', () => {
    expect(mimeOf('a.pdf')).toBe('application/pdf')
    expect(mimeOf('a.mp4')).toBe('video/mp4')
    expect(mimeOf('a.ts')).toBeUndefined()
  })
})

describe('sniffBinary', () => {
  it('NUL dalam SNIFF_BYTES pertama = biner; NUL di luar jendela = bukan', () => {
    expect(sniffBinary(new Uint8Array([65, 0, 66]))).toBe(true)
    const late = new Uint8Array(SNIFF_BYTES + 10).fill(65)
    late[SNIFF_BYTES + 5] = 0
    expect(sniffBinary(late)).toBe(false)
    expect(sniffBinary(new Uint8Array(0))).toBe(false)
  })
})

describe('decodeStrict', () => {
  it('UTF-8 sah (termasuk multibyte) di-decode; byte tak sah -> null', () => {
    expect(decodeStrict(new TextEncoder().encode('€ héllo'))).toBe('€ héllo')
    expect(decodeStrict(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull()
  })

  it('BOM dipertahankan supaya tulis-balik tidak menghapusnya', () => {
    expect(decodeStrict(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('﻿A')
  })
})
