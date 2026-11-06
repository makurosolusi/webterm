// Test-only: a fake browser (its own P-256 key + auth secret) that can decrypt what the server sends,
// and a fetch stand-in that records requests instead of reaching a push service.
import { b64url } from './webPush.crypto'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8))
}

export interface FakeBrowser {
  subscription(endpoint?: string): { endpoint: string; keys: { p256dh: string; auth: string } }
  /** Decrypts one aes128gcm body (RFC 8291) the way the browser would. */
  decrypt(body: Uint8Array): Promise<unknown>
}

export async function fakeBrowser(): Promise<FakeBrowser> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return {
    subscription: (endpoint = `https://fcm.googleapis.com/fcm/send/${b64url(globalThis.crypto.getRandomValues(new Uint8Array(12)))}`) =>
      ({ endpoint, keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } }),
    async decrypt(body) {
      const salt = body.slice(0, 16)
      const idLen = body[20]!
      const asPublic = body.slice(21, 21 + idLen)
      const asKey = await subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256))
      const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
      const ikm = await hkdf(auth, ecdh, info, 32)
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
      const aes = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, body.slice(21 + idLen) as BufferSource))
      return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))))
    },
  }
}

export interface SentRequest { url: string; headers: Record<string, string>; body: Uint8Array }

/** fetch stand-in: records each request, answers `status(url)` (default 201). Never touches the network. */
export function recordingFetch(status: (url: string) => number = () => 201, headers: Record<string, string> = {}): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: new Uint8Array(init?.body as Uint8Array) })
    return new Response(null, { status: status(String(input)), headers })
  }) as typeof fetch
  return { fetch: fn, sent }
}

