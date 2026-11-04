import { describe, it, expect } from 'vitest'
import { decodeFrameHeader, encodeFrame, parseClientMsg } from './browser.wire'
import { TEXT_MAX_BYTES } from './browser.contract'

const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])

describe('encodeFrame / decodeFrameHeader', () => {
  it.each([
    ['', 0], ['n1', 1], ['a'.repeat(255), 0xffff_ffff], ['é'.repeat(127), 123456], // 127*2 = 254 byte
  ])('roundtrip id=%j seq=%d', (id, seq) => {
    const buf = encodeFrame(id, seq, jpeg)
    const h = decodeFrameHeader(buf)!
    expect(h.nodeId).toBe(id)
    expect(h.seq).toBe(seq)
    expect(Array.from(buf.subarray(h.offset))).toEqual(Array.from(jpeg))
    expect(buf[0]).toBe(1)
  })

  it('roundtrip pada subarray dengan byteOffset != 0 (Buffer pool)', () => {
    const buf = encodeFrame('abc', 7, jpeg)
    const padded = new Uint8Array(buf.length + 5)
    padded.set(buf, 5)
    const h = decodeFrameHeader(padded.subarray(5))!
    expect(h).toMatchObject({ nodeId: 'abc', seq: 7 })
  })

  it('id 256 byte ditolak; seq di luar uint32 / non-integer ditolak', () => {
    expect(() => encodeFrame('a'.repeat(256), 0, jpeg)).toThrow(/exceeds 255/)
    expect(() => encodeFrame('é'.repeat(128), 0, jpeg)).toThrow(/256 bytes/)
    expect(() => encodeFrame('a', 2 ** 32, jpeg)).toThrow(/uint32/)
    expect(() => encodeFrame('a', -1, jpeg)).toThrow(/uint32/)
    expect(() => encodeFrame('a', 1.5, jpeg)).toThrow(/uint32/)
  })

  it('frame bercap latensi: tipe 2, lat bulat-balik, jpeg utuh; terpotong -> null', () => {
    const lat = { ls: 1_758_326_400_123.25, rxToDispatch: 0.5, dispatchToSwap: 17.25, swapToServer: 3 } // nilai pas di f32
    const buf = encodeFrame('n1', 9, jpeg, lat)
    expect(buf[0]).toBe(2)
    const h = decodeFrameHeader(buf)!
    expect(h).toMatchObject({ nodeId: 'n1', seq: 9, lat })
    expect(Array.from(buf.subarray(h.offset))).toEqual(Array.from(jpeg))
    expect(decodeFrameHeader(encodeFrame('n1', 9, jpeg))!.lat).toBeUndefined()
    expect(decodeFrameHeader(buf.subarray(0, 2 + 2 + 4 + 19))).toBeNull()
  })

  it('parseClientMsg: ls opsional pada input diteruskan; ls buruk ditolak', () => {
    expect(parseClientMsg({ t: 'text', id: 'n', text: 'a', ls: 12.5 })).toEqual({ t: 'text', id: 'n', text: 'a', ls: 12.5 })
    expect(parseClientMsg({ t: 'text', id: 'n', text: 'a', ls: -1 })).toBeNull()
    expect(parseClientMsg({ t: 'text', id: 'n', text: 'a', ls: 'x' })).toBeNull()
    expect(parseClientMsg({ t: 'text', id: 'n', text: 'a' })).toEqual({ t: 'text', id: 'n', text: 'a' })
  })

  it('decode: bukan frame / terpotong / id bukan utf8 -> null', () => {
    expect(decodeFrameHeader(new Uint8Array([]))).toBeNull()
    expect(decodeFrameHeader(new Uint8Array([2, 0, 0, 0, 0, 0]))).toBeNull()
    expect(decodeFrameHeader(encodeFrame('abc', 1, jpeg).subarray(0, 6))).toBeNull()
    expect(decodeFrameHeader(new Uint8Array([1, 1, 0xff, 0, 0, 0, 1]))).toBeNull()
  })
})

describe('parseClientMsg valid', () => {
  const ok = (m: unknown) => parseClientMsg(JSON.stringify(m))

  it('attach/resize/detach/ack/copy/takeover', () => {
    expect(ok({ t: 'attach', id: 'n', w: 800, h: 600, dpr: 2 })).toEqual({ t: 'attach', id: 'n', w: 800, h: 600, dpr: 2 })
    expect(ok({ t: 'resize', id: 'n', w: 1, h: 2, dpr: 1.5 })).toMatchObject({ t: 'resize' })
    expect(ok({ t: 'detach', id: 'n' })).toEqual({ t: 'detach', id: 'n' })
    expect(ok({ t: 'ack', id: 'n', seq: 4294967295 })).toEqual({ t: 'ack', id: 'n', seq: 4294967295 })
    expect(ok({ t: 'copy', id: 'n' })).toEqual({ t: 'copy', id: 'n' })
    expect(ok({ t: 'takeover', id: 'n' })).toEqual({ t: 'takeover', id: 'n' })
  })

  it('mouse lengkap, dan default untuk field opsional', () => {
    const full = { t: 'mouse', id: 'n', type: 'wheel', x: 10.5, y: -3, button: 'left', buttons: 1, clickCount: 2, mods: 10, dx: 0, dy: 120 }
    expect(ok(full)).toEqual(full)
    expect(ok({ t: 'mouse', id: 'n', type: 'move', x: 1, y: 2 })).toEqual({
      t: 'mouse', id: 'n', type: 'move', x: 1, y: 2, button: 'none', buttons: 0, clickCount: 0, mods: 0, dx: 0, dy: 0,
    })
  })

  it('key, text, ime, touch, nav, dialog; objek hasil parse juga diterima', () => {
    expect(ok({ t: 'key', id: 'n', type: 'down', key: 'a', code: 'KeyA', text: 'a', vk: 65, mods: 8 }))
      .toEqual({ t: 'key', id: 'n', type: 'down', key: 'a', code: 'KeyA', text: 'a', vk: 65, mods: 8 })
    expect(ok({ t: 'text', id: 'n', text: 'héllo' })).toEqual({ t: 'text', id: 'n', text: 'héllo' })
    expect(ok({ t: 'ime', id: 'n', text: 'あ', start: 0, end: 1 })).toMatchObject({ t: 'ime' })
    expect(ok({ t: 'touch', id: 'n', type: 'start', points: [{ x: 1, y: 2, id: 0 }, { x: 3, y: 4, id: 1, force: 0.5 }] }))
      .toMatchObject({ t: 'touch', points: [{ x: 1, y: 2, id: 0 }, { x: 3, y: 4, id: 1, force: 0.5 }] })
    expect(ok({ t: 'nav', id: 'n', action: 'go', url: 'https://a.com' })).toEqual({ t: 'nav', id: 'n', action: 'go', url: 'https://a.com' })
    expect(ok({ t: 'nav', id: 'n', action: 'reload' })).toEqual({ t: 'nav', id: 'n', action: 'reload' })
    expect(ok({ t: 'dialog', id: 'n', accept: true })).toEqual({ t: 'dialog', id: 'n', accept: true })
    expect(ok({ t: 'dialog', id: 'n', accept: false, text: 'x' })).toMatchObject({ text: 'x' })
    expect(parseClientMsg({ t: 'detach', id: 'n' })).toEqual({ t: 'detach', id: 'n' })
  })

  it('teks tepat 64 KiB (byte) diterima', () => {
    expect(ok({ t: 'text', id: 'n', text: 'a'.repeat(TEXT_MAX_BYTES) })).not.toBeNull()
    expect(ok({ t: 'text', id: 'n', text: 'é'.repeat(TEXT_MAX_BYTES / 2) })).not.toBeNull()
  })
})

describe('parseClientMsg ditolak (null)', () => {
  const bad = (m: unknown) => expect(parseClientMsg(typeof m === 'string' ? m : JSON.stringify(m))).toBeNull()
  const viewport = { w: 100, h: 100, dpr: 1 }

  it('bukan JSON / bukan objek / tipe tak dikenal / id buruk', () => {
    bad('{nope'); bad('null'); bad('[]'); bad('"x"'); bad('42')
    expect(parseClientMsg(undefined)).toBeNull()
    expect(parseClientMsg(new Uint8Array(3))).toBeNull()
    bad({ t: 'bogus', id: 'n' })
    bad({ t: 7, id: 'n' })
    bad({ t: 'detach' }); bad({ t: 'detach', id: '' }); bad({ t: 'detach', id: 5 })
    bad({ t: 'detach', id: 'a'.repeat(256) })
  })

  it('angka NaN / Infinity / non-angka / di luar batas', () => {
    // JSON.stringify mengubah NaN/Infinity jadi null; objek langsung menguji jalur sebenarnya.
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(parseClientMsg({ t: 'mouse', id: 'n', type: 'move', x: v, y: 0 })).toBeNull()
      expect(parseClientMsg({ t: 'mouse', id: 'n', type: 'wheel', x: 0, y: 0, dy: v })).toBeNull()
      expect(parseClientMsg({ t: 'attach', id: 'n', w: v, h: 10, dpr: 1 })).toBeNull()
      expect(parseClientMsg({ t: 'touch', id: 'n', type: 'move', points: [{ x: v, y: 0, id: 0 }] })).toBeNull()
    }
    bad({ t: 'mouse', id: 'n', type: 'move', x: null, y: 0 })
    bad({ t: 'mouse', id: 'n', type: 'move', x: '1', y: 0 })
    bad({ t: 'attach', id: 'n', w: 0, h: 10, dpr: 1 })
    bad({ t: 'attach', id: 'n', w: -1, h: 10, dpr: 1 })
    bad({ t: 'attach', id: 'n', w: 1e9, h: 10, dpr: 1 })
    bad({ t: 'resize', id: 'n', ...viewport, dpr: 0 })
    bad({ t: 'ack', id: 'n', seq: -1 }); bad({ t: 'ack', id: 'n', seq: 2 ** 32 }); bad({ t: 'ack', id: 'n', seq: 1.5 })
    bad({ t: 'mouse', id: 'n', type: 'move', x: 0, y: 0, mods: 16 })
    bad({ t: 'mouse', id: 'n', type: 'move', x: 0, y: 0, buttons: -1 })
    bad({ t: 'key', id: 'n', type: 'down', key: 'a', code: 'KeyA', vk: 1.5 })
  })

  it('enum salah / field wajib hilang / tipe salah', () => {
    bad({ t: 'mouse', id: 'n', type: 'drag', x: 0, y: 0 })
    bad({ t: 'mouse', id: 'n', type: 'move', x: 0, y: 0, button: 'LEFT' })
    bad({ t: 'key', id: 'n', type: 'press', key: 'a', code: 'KeyA' })
    bad({ t: 'key', id: 'n', type: 'down', code: 'KeyA' })
    bad({ t: 'nav', id: 'n', action: 'teleport' })
    bad({ t: 'nav', id: 'n', action: 'go' })
    bad({ t: 'nav', id: 'n', action: 'go', url: 5 })
    bad({ t: 'dialog', id: 'n', accept: 'yes' })
    bad({ t: 'touch', id: 'n', type: 'start', points: 'x' })
    bad({ t: 'touch', id: 'n', type: 'start', points: [{ x: 1, y: 1 }] })
    bad({ t: 'touch', id: 'n', type: 'start', points: Array.from({ length: 11 }, (_, i) => ({ x: 0, y: 0, id: i })) })
    bad({ t: 'touch', id: 'n', type: 'start', points: [{ x: 0, y: 0, id: 0, force: 2 }] })
    bad({ t: 'ime', id: 'n', text: 'a', start: -1, end: 0 })
  })

  it('oversize: teks > 64 KiB (karakter dan byte), URL, field key, dan string mentah', () => {
    bad({ t: 'text', id: 'n', text: 'a'.repeat(TEXT_MAX_BYTES + 1) })
    bad({ t: 'text', id: 'n', text: 'é'.repeat(TEXT_MAX_BYTES / 2 + 1) })
    bad({ t: 'ime', id: 'n', text: 'a'.repeat(TEXT_MAX_BYTES + 1), start: 0, end: 0 })
    bad({ t: 'dialog', id: 'n', accept: true, text: 'a'.repeat(TEXT_MAX_BYTES + 1) })
    bad({ t: 'nav', id: 'n', action: 'go', url: 'https://a.com/' + 'x'.repeat(9000) })
    bad({ t: 'key', id: 'n', type: 'down', key: 'k'.repeat(65), code: 'KeyA' })
    expect(parseClientMsg('x'.repeat(TEXT_MAX_BYTES * 8 + 1))).toBeNull()
  })
})
