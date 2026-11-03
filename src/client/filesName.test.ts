import { describe, expect, it } from 'vitest'
import { checkName, copyName, MAX_NAME_BYTES, stemEnd } from './filesName'

describe('checkName', () => {
  it('menerima nama biasa dan men-trim', () => {
    expect(checkName('  a.txt ')).toEqual({ ok: true, name: 'a.txt' })
    expect(checkName('.env')).toEqual({ ok: true, name: '.env' })
  })

  it.each([
    ['', 'empty'], ['   ', 'empty'],
    ['.', 'reserved'], ['..', 'reserved'],
    ['a/b', 'slash'], ['a\\b', 'slash'], ['/abs', 'slash'],
    ['a\0b', 'nul'],
  ])('menolak %j sebagai %s', (raw, problem) => {
    expect(checkName(raw)).toEqual({ ok: false, problem })
  })

  it('batas 255 BYTE (bukan karakter): 255 ASCII lolos, 128 karakter 2-byte tidak', () => {
    expect(checkName('a'.repeat(MAX_NAME_BYTES)).ok).toBe(true)
    expect(checkName('a'.repeat(MAX_NAME_BYTES + 1))).toEqual({ ok: false, problem: 'long' })
    expect(checkName('é'.repeat(128))).toEqual({ ok: false, problem: 'long' })
  })
})

describe('stemEnd', () => {
  it('titik awal bukan ekstensi; titik terakhir yang dipakai', () => {
    expect(stemEnd('a.tar.gz')).toBe(5)
    expect(stemEnd('.env')).toBe(4)
    expect(stemEnd('Makefile')).toBe(8)
  })
})

describe('copyName', () => {
  it('"name copy", lalu "name copy 2", dst; ekstensi tetap di ujung', () => {
    expect(copyName('a.txt', ['a.txt'])).toBe('a copy.txt')
    expect(copyName('a.txt', ['a.txt', 'a copy.txt'])).toBe('a copy 2.txt')
    expect(copyName('a.txt', ['a.txt', 'a copy.txt', 'a copy 2.txt'])).toBe('a copy 3.txt')
    expect(copyName('dir', ['dir'])).toBe('dir copy')
    expect(copyName('.env', ['.env'])).toBe('.env copy')
  })

  it('duplikat dari duplikat tidak menumpuk akhiran', () => {
    expect(copyName('a copy.txt', ['a.txt', 'a copy.txt'])).toBe('a copy 2.txt')
  })

  it('tak peka huruf besar dan NFC terhadap nama yang sudah ada', () => {
    expect(copyName('a.txt', ['A COPY.TXT'])).toBe('a copy 2.txt')
    expect(copyName('é', ['é copy'.normalize('NFD')])).toBe('é copy 2')
  })
})
