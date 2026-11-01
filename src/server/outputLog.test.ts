import { beforeEach, describe, expect, it } from 'vitest'

import { OutputLog } from './outputLog'

describe('OutputLog', () => {
  let log: OutputLog

  beforeEach(() => {
    log = new OutputLog()
  })

  it('starts empty with no seq handed out yet', () => {
    expect(log.lastSeq()).toBe(0)
    expect(log.floorSeq()).toBe(1)
    expect(log.text()).toBe('')
    expect(log.bytes()).toBe(0)
    expect(log.since(0)).toEqual([])
  })

  describe('seq', () => {
    it('hands out 1, 2, 3... and reports the last one', () => {
      expect(log.append('a', 1024)).toBe(1)
      expect(log.append('b', 1024)).toBe(2)
      expect(log.append('c', 1024)).toBe(3)
      expect(log.lastSeq()).toBe(3)
    })

    it('does not burn a seq on an empty append', () => {
      expect(log.append('a', 1024)).toBe(1)
      expect(log.append('', 1024)).toBe(1)
      expect(log.append('b', 1024)).toBe(2)
      expect(log.text()).toBe('ab')
    })
  })

  describe('since', () => {
    it('returns only chunks after the given seq, oldest first', () => {
      log.append('a', 1024)
      log.append('b', 1024)
      log.append('c', 1024)
      expect(log.since(0)).toEqual([
        { seq: 1, data: 'a' },
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
      ])
      expect(log.since(1)).toEqual([
        { seq: 2, data: 'b' },
        { seq: 3, data: 'c' },
      ])
      expect(log.since(2)).toEqual([{ seq: 3, data: 'c' }])
    })

    it('returns nothing when caught up or ahead', () => {
      log.append('a', 1024)
      expect(log.since(1)).toEqual([])
      expect(log.since(99)).toEqual([])
    })
  })

  describe('byte cap', () => {
    it('drops whole oldest chunks until the total fits', () => {
      // 4 byte per chunk, cap 8: hanya dua chunk terakhir yang muat (kecuali keduanya melewati cap).
      log.append('aaaa', 1024)
      log.append('bbbb', 1024)
      log.append('cccc', 8)
      expect(log.text()).toBe('bbbbcccc')
      expect(log.bytes()).toBe(8)
      log.append('dddd', 8)
      expect(log.text()).toBe('ccccdddd')
      expect(log.bytes()).toBe(8)
    })

    it('keeps the newest chunk even when it alone exceeds the cap', () => {
      log.append('aaaa', 1024)
      log.append('aaaaaaaa', 4)
      expect(log.since(0)).toEqual([{ seq: 2, data: 'aaaaaaaa' }])
      expect(log.text()).toBe('aaaaaaaa')
      expect(log.bytes()).toBe(8)
    })

    it('counts multi-byte UTF-8 as bytes, not UTF-16 code units', () => {
      // 'é' 2 byte, '漢' 3 byte, '🙂' 4 byte. Sebagai karakter JS semuanya length 1-2.
      expect(log.append('é', 1024)).toBe(1)
      expect(log.bytes()).toBe(2)
      log.append('漢', 1024)
      expect(log.bytes()).toBe(5)
      log.append('🙂', 1024)
      expect(log.bytes()).toBe(9)

      // Cap 5 hanya muat '漢' + '🙂' (7 byte untuk dua terakhir -> evict 'é'), lalu masih > 5
      // sehingga '漢' juga pergi; '🙂' tetap tinggal karena ia potongan terbaru.
      log.append('x', 5)
      expect(log.text()).toBe('🙂x')
      expect(log.bytes()).toBe(5)
    })
  })

  describe('gap detection', () => {
    it('moves floorSeq forward when chunks are evicted, while lastSeq keeps its value', () => {
      log.append('aaaa', 4)
      log.append('bbbb', 4)
      log.append('cccc', 4)
      expect(log.floorSeq()).toBe(3)
      expect(log.lastSeq()).toBe(3)
      expect(log.since(0)).toEqual([{ seq: 3, data: 'cccc' }])
      // Pemanggil yang tertinggal di seq 1 tahu ada gap: floorSeq() > held + 1.
      expect(log.floorSeq()).toBeGreaterThan(1 + 1)
    })

    it('does not move floorSeq when nothing was evicted', () => {
      log.append('a', 1024)
      log.append('b', 1024)
      expect(log.floorSeq()).toBe(1)
    })
  })
})
