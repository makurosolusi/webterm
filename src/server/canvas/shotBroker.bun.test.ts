import { describe, expect, test } from 'bun:test'
import { createShotBroker, type ShotFrame } from './shotBroker'

const IMG = { ok: true as const, mimeType: 'image/jpeg', data: '/9j/4A==' } // test-only

function broker(timeoutMs = 1000, maxPending?: number) {
  const frames: ShotFrame[] = []
  const b = createShotBroker({ broadcast: (m) => { frames.push(m) }, timeoutMs, ...(maxPending ? { maxPending } : {}) })
  return { b, frames }
}

describe('shot broker', () => {
  test('broadcasts a shot frame and the first answer wins; a second tab gets answered', async () => {
    const { b, frames } = broker()
    const p = b.request(1200)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ t: 'shot', maxWidth: 1200 })
    const id = frames[0]!.reqId
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.answer(id, IMG)).toBe('ok')
    expect(b.answer(id, { ok: false, code: 'late' })).toBe('answered')
    expect(await p).toEqual(IMG)
  })

  test('unknown ids answer unknown', () => {
    expect(broker().b.answer('00000000-0000-0000-0000-000000000000', IMG)).toBe('unknown')
  })

  test('nobody answering times out as no_visible_window, then the id is unknown', async () => {
    const { b, frames } = broker(20)
    expect(await b.request(800)).toEqual({ ok: false, code: 'no_visible_window' })
    expect(b.answer(frames[0]!.reqId, IMG)).toBe('unknown')
  })

  test('a client error code is passed through', async () => {
    const { b, frames } = broker()
    const p = b.request(800)
    b.answer(frames[0]!.reqId, { ok: false, code: 'capture_failed' })
    expect(await p).toEqual({ ok: false, code: 'capture_failed' })
  })

  test('caps concurrent requests: the next one is busy without broadcasting', async () => {
    const { b, frames } = broker(1000, 2)
    const a = b.request(800)
    const c = b.request(800)
    expect(await b.request(800)).toEqual({ ok: false, code: 'busy' })
    expect(frames).toHaveLength(2)
    for (const f of frames) b.answer(f.reqId, IMG)
    await Promise.all([a, c])
  })

  test('by default one screenshot at a time: a second concurrent request is busy, then the slot frees', async () => {
    const { b, frames } = broker()
    const a = b.request(800)
    expect(await b.request(800)).toEqual({ ok: false, code: 'busy' })
    expect(frames).toHaveLength(1)
    b.answer(frames[0]!.reqId, IMG)
    expect(await a).toEqual(IMG)
    const c = b.request(800)
    expect(frames).toHaveLength(2)
    b.answer(frames[1]!.reqId, IMG)
    await c
  })

  test('a failed broadcast rejects with a code and frees the slot', async () => {
    const b = createShotBroker({ broadcast: () => { throw new Error('socket gone') }, maxPending: 1 })
    expect(await b.request(800).catch((e: unknown) => e)).toMatchObject({ code: 'broadcast_failed' })
    expect(await b.request(800).catch((e: unknown) => e)).toMatchObject({ code: 'broadcast_failed' }) // not 'busy'
  })
})
