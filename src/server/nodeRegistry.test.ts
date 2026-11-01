import { describe, expect, it } from 'vitest'

import { WORKING_STALE_MS } from '../shared/agentStale'
import { EXIT_TOMBSTONE_LIMIT, NodeRegistry } from './nodeRegistry'

const T0 = 1_000_000

describe('NodeRegistry status', () => {
  it('stores status with the injected clock', () => {
    const reg = new NodeRegistry()
    reg.setStatus('n1', 'working', T0)
    expect(reg.getStatus('n1')).toEqual({ status: 'working', updatedAt: T0 })
    expect(reg.getStatus('missing')).toBeUndefined()
  })

  it('does not leak its internal entry by reference', () => {
    const reg = new NodeRegistry()
    reg.setStatus('n1', 'working', T0)
    const entry = reg.getStatus('n1')!
    entry.updatedAt = T0 - 10 * WORKING_STALE_MS
    expect(reg.getStatus('n1')).toEqual({ status: 'working', updatedAt: T0 })
  })

  it('sweeps only stale working and returns the removed ids', () => {
    const reg = new NodeRegistry()
    reg.setStatus('stale', 'working', T0)
    reg.setStatus('fresh', 'working', T0 + WORKING_STALE_MS)
    reg.setStatus('waiting', 'waiting', T0)
    reg.setStatus('done', 'done', T0)

    const swept = reg.sweepStale(T0 + WORKING_STALE_MS + 1)

    expect(swept).toEqual(['stale'])
    expect(reg.getStatus('stale')).toBeUndefined()
    // `working` yang baru diperbarui belum basi.
    expect(reg.getStatus('fresh')).toEqual({ status: 'working', updatedAt: T0 + WORKING_STALE_MS })
    // Status non-working tidak pernah kedaluwarsa, sejauh apa pun jamnya maju.
    expect(reg.getStatus('waiting')?.status).toBe('waiting')
    expect(reg.getStatus('done')?.status).toBe('done')
  })

  it('keeps working at exactly the stale boundary', () => {
    const reg = new NodeRegistry()
    reg.setStatus('n1', 'working', T0)
    expect(reg.sweepStale(T0 + WORKING_STALE_MS)).toEqual([])
    expect(reg.getStatus('n1')?.status).toBe('working')
  })

  it('deletes status on demand', () => {
    const reg = new NodeRegistry()
    reg.setStatus('n1', 'blocked', T0)
    reg.deleteStatus('n1')
    expect(reg.getStatus('n1')).toBeUndefined()
  })
})

describe('NodeRegistry transcript', () => {
  it('stores, reads and deletes the transcript path', () => {
    const reg = new NodeRegistry()
    reg.setTranscript('n1', '/tmp/transcript.jsonl')
    expect(reg.getTranscript('n1')).toBe('/tmp/transcript.jsonl')
    reg.deleteTranscript('n1')
    expect(reg.getTranscript('n1')).toBeUndefined()
  })
})

describe('NodeRegistry exit tombstones', () => {
  it('records a self exit', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 0, reason: 'self', at: T0 })
    expect(reg.getExit('n1')).toEqual({ code: 0, reason: 'self', at: T0 })
    expect(reg.getExit('missing')).toBeUndefined()
  })

  it('lets a self exit win over an earlier closed tombstone', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 143, reason: 'closed', at: T0 })
    reg.setExit('n1', { code: 1, reason: 'self', at: T0 + 5 })
    expect(reg.getExit('n1')).toEqual({ code: 1, reason: 'self', at: T0 + 5 })
  })

  it('does not let a closed exit overwrite a self tombstone', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 1, reason: 'self', at: T0 })
    reg.setExit('n1', { code: 137, reason: 'closed', at: T0 + 5 })
    expect(reg.getExit('n1')).toEqual({ code: 1, reason: 'self', at: T0 })
  })

  it('keeps the first tombstone when the same reason arrives again', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 1, reason: 'self', at: T0 })
    reg.setExit('n1', { code: 2, reason: 'self', at: T0 + 5 })
    expect(reg.getExit('n1')).toEqual({ code: 1, reason: 'self', at: T0 })
  })

  it('bounds tombstones to the limit, evicting the oldest insertion', () => {
    const reg = new NodeRegistry()
    const total = EXIT_TOMBSTONE_LIMIT + 1
    for (let i = 0; i < total; i++) {
      reg.setExit(`n${i}`, { code: 0, reason: 'self', at: T0 + i })
    }

    // Yang tertua dibuang, yang terbaru tetap ada.
    expect(reg.getExit('n0')).toBeUndefined()
    expect(reg.getExit(`n${total - 1}`)).toEqual({
      code: 0,
      reason: 'self',
      at: T0 + total - 1,
    })

    let alive = 0
    for (let i = 0; i < total; i++) if (reg.getExit(`n${i}`)) alive++
    expect(alive).toBe(EXIT_TOMBSTONE_LIMIT)
  })

  it('clears one tombstone without touching the others', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 0, reason: 'self', at: T0 })
    reg.setExit('n2', { code: 0, reason: 'self', at: T0 })
    reg.clearExit('n1')
    expect(reg.getExit('n1')).toBeUndefined()
    expect(reg.getExit('n2')).toBeDefined()
  })

  it('P0: a cleared tombstone does not block a fresh exit record for the same id', () => {
    const reg = new NodeRegistry()
    reg.setExit('n1', { code: 7, reason: 'self', at: T0 })
    reg.clearExit('n1')
    expect(reg.getExit('n1')).toBeUndefined()

    // Sesi baru dengan id yang sama menulis tombstone barunya sendiri, bukan warisan lama.
    reg.setExit('n1', { code: 0, reason: 'self', at: T0 + 99 })
    expect(reg.getExit('n1')).toEqual({ code: 0, reason: 'self', at: T0 + 99 })
  })
})

describe('NodeRegistry forget', () => {
  it('clears status, transcript and exit for the node only', () => {
    const reg = new NodeRegistry()
    reg.setStatus('n1', 'working', T0)
    reg.setStatus('n2', 'working', T0)
    reg.setTranscript('n1', '/tmp/a.jsonl')
    reg.setTranscript('n2', '/tmp/b.jsonl')
    reg.setExit('n1', { code: 0, reason: 'self', at: T0 })
    reg.setExit('n2', { code: 0, reason: 'self', at: T0 })

    reg.forget('n1')

    expect(reg.getStatus('n1')).toBeUndefined()
    expect(reg.getTranscript('n1')).toBeUndefined()
    expect(reg.getExit('n1')).toBeUndefined()
    // Node lain tidak ikut terhapus.
    expect(reg.getStatus('n2')?.status).toBe('working')
    expect(reg.getTranscript('n2')).toBe('/tmp/b.jsonl')
    expect(reg.getExit('n2')?.reason).toBe('self')
  })
})
