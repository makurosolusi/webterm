// Klasifikasi IP untuk penjaga SSRF (c §6.1). Murni, fail-closed: apa pun yang bukan IP valid atau
// bukan unicast global dianggap 'private'. IPv4-mapped/compat, NAT64 /96 dan 6to4 dinilai lewat IPv4 tertanam.
import { isIPv4, isIPv6 } from 'node:net'

export type IpClass = 'public' | 'private'

/** Rentang IPv4 non-publik (CIDR); 224.0.0.0/3 mencakup multicast, reserved, dan broadcast. */
const V4_NON_PUBLIC = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
]
const V4_BITS = 32
const GROUP_BITS = 16
const V6_GROUPS = 8
const V6_GLOBAL_TOP = 0x2000 // 2000::/3 = satu-satunya unicast global
const V6_GLOBAL_MASK = 0xe000

const v4ToInt = (ip: string): number => ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0)
const inCidr = (n: number, [base, bits]: readonly [number, number]): boolean =>
  bits === 0 || n >>> (V4_BITS - bits) === base >>> (V4_BITS - bits)
const NON_PUBLIC_V4 = V4_NON_PUBLIC.map((c): [number, number] => {
  const [ip, bits] = c.split('/')
  return [v4ToInt(ip), Number(bits)]
})
const LOOPBACK_V4: [number, number][] = [[v4ToInt('127.0.0.0'), 8], [0, 8]]

const pair = (hi: number, lo: number): number => ((hi << GROUP_BITS) | lo) >>> 0

/** Uraikan IPv6 ke 8 grup 16-bit; null bila tak valid. */
function parseV6(ip: string): number[] | null {
  let s = ip.split('%')[0]
  const tail = s.slice(s.lastIndexOf(':') + 1)
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null
    const o = tail.split('.').map(Number)
    s = `${s.slice(0, s.lastIndexOf(':') + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = V6_GROUPS - head.length - rest.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

/** IPv4 efektif (int) untuk IPv4 biasa dan bentuk IPv6 yang menanamnya; null untuk IPv6 asli / tak valid. */
function effectiveV4(ip: string): number | null {
  if (isIPv4(ip)) return v4ToInt(ip)
  if (!isIPv6(ip)) return null
  const g = parseV6(ip)
  if (!g) return null
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0)
  if (zeros(0, 6)) return pair(g[6], g[7]) // ::/96 compat (juga '::' dan '::1')
  if (zeros(0, 5) && g[5] === 0xffff) return pair(g[6], g[7]) // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return pair(g[6], g[7]) // 64:ff9b::/96
  if (g[0] === 0x2002) return pair(g[1], g[2]) // 6to4
  return null
}

/** 'public' hanya untuk unicast global; semua rentang privat/loopback/link-local/CGNAT/ULA/mapped dan input tak valid = 'private'. */
export function classifyIp(ip: string): IpClass {
  const v4 = effectiveV4(ip)
  if (v4 !== null) return NON_PUBLIC_V4.some((r) => inCidr(v4, r)) ? 'private' : 'public'
  const g = isIPv6(ip) ? parseV6(ip) : null
  if (!g || (g[0] & V6_GLOBAL_MASK) !== V6_GLOBAL_TOP) return 'private'
  const [a, b] = g
  if (a === 0x2001 && (b === 0 || b === 0x0db8 || (b & 0xfff0) === 0x10)) return 'private' // Teredo, dokumentasi, ORCHID
  if (a === 0x3fff && (b & 0xf000) === 0) return 'private' // dokumentasi
  return 'public'
}

/** True untuk 127/8, 0.0.0.0/8, ::, ::1 (juga bentuk mapped/compat); dasar hard-deny port webterm sendiri. */
export function isLoopbackOrUnspecified(ip: string): boolean {
  const v4 = effectiveV4(ip)
  return v4 !== null && LOOPBACK_V4.some((r) => inCidr(v4, r))
}
