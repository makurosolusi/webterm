/** crypto.randomUUID exists only in a secure context (https, localhost, 127.0.0.1). Served over http
 *  from a LAN address (0.0.0.0, 10.x, 192.168.x) the page is not secure, so it is undefined and calling
 *  it throws — and with no error boundary that blanks the whole app. getRandomValues has no such gate. */
export function randomId(): string {
  const c = globalThis.crypto
  if (c.randomUUID) return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}
