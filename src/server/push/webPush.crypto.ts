// Web Push wire format with WebCrypto only (no dependency): VAPID (RFC 8292) and the aes128gcm
// payload encryption (RFC 8291 over RFC 8188). The `web-push` npm package does the same with four
// transitive deps; the whole job is ~80 lines of HKDF + ECDH + AES-GCM, so it lives here.
// Verified against the RFC 8291 Appendix A test vector (webPush.crypto.test.ts). Pure: no I/O.

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const RECORD_SIZE = 4096
/** 16-byte salt + 4-byte record size + 1-byte key id length + 65-byte public key. */
const HEADER_BYTES = 86

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}
export function fromB64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8))
}

/** Uncompressed P-256 point (0x04 || x || y) -> JWK coordinates. */
function pointToJwk(point: Uint8Array): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  if (point.length !== 65 || point[0] !== 4) throw new Error('web push: public key must be a 65-byte uncompressed P-256 point')
  return { kty: 'EC', crv: 'P-256', x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)) }
}

export function jwkToPoint(jwk: JsonWebKey): Uint8Array {
  if (!jwk.x || !jwk.y) throw new Error('web push: JWK has no public coordinates')
  return concat(Uint8Array.of(4), fromB64url(jwk.x), fromB64url(jwk.y))
}

export interface EncryptOptions {
  /** Test-only injection (RFC vector); production draws both at random per message. */
  salt?: Uint8Array
  sender?: { privateJwk: JsonWebKey; publicPoint: Uint8Array }
}

/** RFC 8291 §3.4: one aes128gcm record; returns the full request body (header + ciphertext). */
export async function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
  if (plaintext.length > RECORD_SIZE - HEADER_BYTES - 17) throw new Error('web push: payload too large')
  const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16))
  let asPrivate: CryptoKey
  let asPublic: Uint8Array
  if (opts.sender) {
    asPrivate = await subtle.importKey('jwk', opts.sender.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    asPublic = opts.sender.publicPoint
  } else {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
    asPrivate = pair.privateKey
    asPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  }
  const uaKey = await subtle.importKey('jwk', pointToJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256))
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const aes = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  // 0x02 = padding delimiter of the last (only) record.
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, concat(plaintext, Uint8Array.of(2)) as BufferSource))
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE)
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, sealed)
}

export interface VapidKeys { privateJwk: JsonWebKey; publicKey: string }

/** A fresh VAPID key pair; `publicKey` is the base64url point the browser takes as applicationServerKey. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey)
  return { privateJwk, publicKey: b64url(jwkToPoint(privateJwk)) }
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one push service origin (RFC 8292 §3). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec: number, ttlSec = 12 * 3600): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + ttlSec, sub: subject })))
  const key = await subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // WebCrypto ECDSA already returns IEEE P1363 r||s, which is the JWS ES256 signature format.
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`
}
