import { describe, expect, it } from 'vitest'
import { FRAME_TYPE, FRAME_TYPE_AUDIO, FRAME_TYPE_TIMED } from './browser.contract'
import { decodeAudioFrame, decodeFrameHeader, encodeAudioFrame, parseClientMsg } from './browser.wire'

const chunk = { nodeId: 'node-1', streamKey: 'ab12c0', seq: 7, t: 1_760_000_000_123.5, payload: new Uint8Array([1, 2, 3, 250]) }

describe('audio frame', () => {
  it('round-trips nodeId, stream key, seq, server time and payload', () => {
    const out = decodeAudioFrame(encodeAudioFrame(chunk))
    expect(out).toMatchObject({ nodeId: 'node-1', streamKey: 'ab12c0', seq: 7, t: 1_760_000_000_123.5 })
    expect([...out!.payload]).toEqual([1, 2, 3, 250])
  })

  it('has its own type, registered once and distinct from the video types; the video decoder ignores it', () => {
    expect(new Set([FRAME_TYPE, FRAME_TYPE_TIMED, FRAME_TYPE_AUDIO]).size).toBe(3)
    expect(encodeAudioFrame(chunk)[0]).toBe(FRAME_TYPE_AUDIO)
    expect(decodeFrameHeader(encodeAudioFrame(chunk))).toBeNull() // an old client skips what it does not know
  })

  it('rejects a bad stream key, a seq that is not uint32 and truncated input', () => {
    expect(() => encodeAudioFrame({ ...chunk, streamKey: 'BAD KEY' })).toThrow(/streamKey/)
    expect(() => encodeAudioFrame({ ...chunk, seq: -1 })).toThrow(/uint32/)
    expect(decodeAudioFrame(encodeAudioFrame(chunk).subarray(0, 12))).toBeNull()
    expect(decodeAudioFrame(new Uint8Array([FRAME_TYPE, 0]))).toBeNull()
  })
})

describe('audio client message', () => {
  it('parses {t:audio,id,on}', () => {
    expect(parseClientMsg({ t: 'audio', id: 'n1', on: true })).toEqual({ t: 'audio', id: 'n1', on: true })
    expect(parseClientMsg({ t: 'audio', id: 'n1', on: false })).toEqual({ t: 'audio', id: 'n1', on: false })
  })
  it('rejects a missing or non-boolean on, and an empty id', () => {
    expect(parseClientMsg({ t: 'audio', id: 'n1' })).toBeNull()
    expect(parseClientMsg({ t: 'audio', id: 'n1', on: 'yes' })).toBeNull()
    expect(parseClientMsg({ t: 'audio', id: '', on: true })).toBeNull()
  })
})
