import { describe, expect, it } from 'vitest'
import { b64url, encryptPayload, fromB64url, generateVapidKeys, jwkToPoint, vapidAuthorization } from './webPush.crypto'

// RFC 8291 Appendix A (test-only key material, published in the RFC).
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('encryptPayload (RFC 8291)', () => {
  it('reproduces the Appendix A ciphertext byte for byte', async () => {
    const point = fromB64url(V.asPublic)
    const privateJwk = { kty: 'EC', crv: 'P-256', d: V.asPrivate, x: b64url(point.slice(1, 33)), y: b64url(point.slice(33)) }
    const out = await encryptPayload(new TextEncoder().encode(V.plaintext), fromB64url(V.uaPublic), fromB64url(V.auth), {
      salt: fromB64url(V.salt), sender: { privateJwk, publicPoint: point },
    })
    expect(b64url(out)).toBe(V.body)
  })

  it('uses a fresh salt and sender key per message', async () => {
    const a = await encryptPayload(new Uint8Array([1]), fromB64url(V.uaPublic), fromB64url(V.auth))
    const b = await encryptPayload(new Uint8Array([1]), fromB64url(V.uaPublic), fromB64url(V.auth))
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16)))
    expect(a.length).toBe(86 + 1 + 1 + 16)
  })

  it('rejects a malformed browser key', async () => {
    await expect(encryptPayload(new Uint8Array([1]), new Uint8Array(10), fromB64url(V.auth))).rejects.toThrow(/65-byte/)
  })
})

describe('VAPID', () => {
  it('signs an ES256 JWT for the push service origin that verifies with the public key', async () => {
    const keys = await generateVapidKeys()
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@example.com', 1000)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, h, c, s, k] = m!
    expect(k).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:a@example.com' })
    const pub = await crypto.subtle.importKey('raw', jwkToPoint(keys.privateJwk) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(s!) as BufferSource, new TextEncoder().encode(`${h}.${c}`))
    expect(ok).toBe(true)
  })
})
