// Magic-byte sniffing of wallpaper uploads: the bytes decide the type, never a name or Content-Type.
import { expect, test } from 'bun:test'
import { isAnimatedWebp } from '../shared/canvasBackground.schema'
import { sniffImage, sniffMedia, sniffVideo } from './canvasBackground.sniff'

// test-only: smallest headers that pass each sniff.
const riff = (chunk: string, flags: number): Buffer => {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write(chunk, 12, 'latin1'); b[20] = flags
  return b
}
const mp4 = (brand: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(16)])
const webm = (docType: string): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(docType, 'latin1'), Buffer.alloc(8)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])

test('webp: still vs animated is told apart by the VP8X animation flag', () => {
  expect(sniffMedia(riff('VP8X', 0x10))).toEqual({ ext: 'webp', animated: false }) // alpha only
  expect(sniffMedia(riff('VP8X', 0x12))).toEqual({ ext: 'webp', animated: true })
  expect(sniffMedia(riff('VP8 ', 0x02))).toEqual({ ext: 'webp', animated: false }) // lossy still: no VP8X header
  expect(isAnimatedWebp(riff('VP8X', 0x02).subarray(0, 20))).toBe(false) // truncated before the flags byte
})

test('png, jpg and gif: still except gif, which is treated as moving', () => {
  expect(sniffMedia(PNG)).toEqual({ ext: 'png', animated: false })
  expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ ext: 'jpg', animated: false })
  expect(sniffMedia(Buffer.from('GIF89a......'))).toEqual({ ext: 'gif', animated: true })
  expect(sniffImage(mp4('isom'))).toBeNull()
})

test('mp4 accepts the known brands and nothing else', () => {
  for (const brand of ['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'M4V ']) expect(sniffVideo(mp4(brand))).toBe('mp4')
  expect(sniffMedia(mp4('mp42'))).toEqual({ ext: 'mp4', animated: true })
  expect(sniffVideo(mp4('qt  '))).toBeNull()
  expect(sniffVideo(mp4('heic'))).toBeNull()
})

test('webm needs the EBML magic and the webm DocType; matroska is refused', () => {
  expect(sniffMedia(webm('webm'))).toEqual({ ext: 'webm', animated: true })
  expect(sniffVideo(webm('matroska'))).toBeNull()
  expect(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf]))).toBeNull()
})

test('fake or too-short input is not media', () => {
  for (const bad of [Buffer.alloc(0), Buffer.from('<svg onload=1>'), Buffer.from('ftyp'), Buffer.from([0, 0, 0, 0x18]), Buffer.alloc(40)]) {
    expect(sniffMedia(bad)).toBeNull()
  }
})
