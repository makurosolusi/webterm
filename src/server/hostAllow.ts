// Allowlist header Host: penutup DNS rebinding saat server tanpa token. Fungsi murni, tanpa
// state, jadi bisa diuji tanpa membuka port. Pemasangan ke gerbang ada di auth.ts.
export const ALLOWED_HOSTS_KEY = 'WEBTERM_ALLOWED_HOSTS'
/** Entri valid maksimum dari env; lebihnya diabaikan dan dihitung di `ignored`. */
export const ALLOWED_HOSTS_MAX = 32
/** Bentuk `host` atau `host:port` setelah trim + lowercase + buang titik akhir; tanpa skema/path/wildcard. */
export const HOST_ENTRY_SHAPE = /^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/
export const ALWAYS_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']
/** Panjang Host yang boleh masuk log (batas nama DNS). */
export const HOST_LOG_MAX = 253
const MAX_PORT = 65535
/** Alamat wildcard bukan nama yang pernah dikirim klien di header Host. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::'])

export interface HostAllowlist {
  /** Nama yang diterima di port mana pun. */
  readonly names: ReadonlySet<string>
  /** `nama:port` yang diterima tepat. */
  readonly withPort: ReadonlySet<string>
  /** Entri env ngawur atau melebihi `ALLOWED_HOSTS_MAX`. */
  readonly ignored: number
}

/** Pecah Host/entri jadi nama + port; undefined bila bentuknya tidak valid. */
function parseHost(raw: string): { name: string; port?: string } | undefined {
  const [, name = '', port] = /^(.*?)(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase()) ?? []
  const bare = name.replace(/\.$/, '')
  if (!HOST_ENTRY_SHAPE.test(port === undefined ? bare : `${bare}:${port}`)) return undefined
  if (port !== undefined && Number(port) > MAX_PORT) return undefined
  return { name: bare, port }
}

/** Himpunan Host yang diterima: loopback + host bind (bukan wildcard) + entri `WEBTERM_ALLOWED_HOSTS`. */
export function buildAllowedHosts(i: { host: string; port: number; env: NodeJS.ProcessEnv }): HostAllowlist {
  const names = new Set<string>()
  const withPort = new Set<string>()
  let ignored = 0
  const add = (raw: string): boolean => {
    const p = parseHost(raw)
    if (p === undefined) return false
    if (p.port === undefined) names.add(p.name)
    else withPort.add(`${p.name}:${p.port}`)
    return true
  }
  ALWAYS_ALLOWED_HOSTS.forEach(add)
  // IPv6 telanjang (`::1`) harus berkurung supaya sama dengan bentuk di header Host.
  const bind = i.host.includes(':') && !i.host.startsWith('[') ? `[${i.host}]` : i.host
  if (!WILDCARD_HOSTS.has(i.host)) add(bind)
  const entries = (i.env[ALLOWED_HOSTS_KEY] ?? '').split(',').map((e) => e.trim()).filter((e) => e !== '')
  let accepted = 0
  for (const e of entries) {
    if (accepted < ALLOWED_HOSTS_MAX && add(e)) accepted++
    else ignored++
  }
  return { names, withPort, ignored }
}

/** Header Host diterima? Kosong, ganda (array), atau tak valid => ditolak. */
export function hostAllowed(hostHeader: string | string[] | undefined, list: HostAllowlist): boolean {
  if (typeof hostHeader !== 'string') return false
  const p = parseHost(hostHeader)
  if (p === undefined) return false
  return list.names.has(p.name) || (p.port !== undefined && list.withPort.has(`${p.name}:${p.port}`))
}

/** Host aman untuk log: tanpa karakter kontrol (anti log-injection), dipotong `HOST_LOG_MAX`. */
export function safeHostForLog(hostHeader: unknown): string {
  return String(hostHeader ?? '').replace(/\p{Cc}/gu, '').slice(0, HOST_LOG_MAX)
}
