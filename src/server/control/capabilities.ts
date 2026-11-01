import { createHash, randomBytes } from 'node:crypto'

/**
 * Token kapabilitas in-memory untuk kontrol node dari agent pusat.
 *
 * Token hanya disimpan sebagai sha256-nya, jadi kebocoran isi map tidak langsung
 * memberi token yang bisa dipakai. Semua waktu (`now`) di-inject supaya kedaluwarsa
 * dan sweep bisa dites tanpa menunggu jam dinding.
 */

/** Verb yang boleh dimintakan lewat capability. */
export type CapabilityVerb =
  | 'node.spawn'
  | 'node.prompt'
  | 'node.wait'
  | 'node.close'
  | 'node.read'
  | 'plan.read'
  | 'approval.request'
  | 'approval.decide'
  | 'approval.consume'
  | 'approval.read'

export const CAPABILITY_VERBS: readonly CapabilityVerb[] = [
  'node.spawn',
  'node.prompt',
  'node.wait',
  'node.close',
  'node.read',
  'plan.read',
  'approval.request',
  'approval.decide',
  'approval.consume',
  'approval.read',
]

/**
 * Resource sasaran: `node:<id>`, `workspace:<id>`, `project:<id>`, atau `*`.
 * `*` HANYA sah untuk `node.read` (lihat `mint`).
 */
export type CapabilityResource = string

/** Syarat tambahan yang harus dipenuhi konteks pemanggil. */
export interface CapabilityQualifier {
  /** Kalau diisi, hanya agent dengan id ini yang boleh memakai token. */
  agentIds?: string[]
  /** Kalau diisi, cwd pemanggil harus diawali prefix ini. */
  cwdPrefix?: string
}

/** Konteks pemanggil untuk mengecek qualifier. */
export interface CapabilityContext {
  agentId?: string
  cwd?: string
}

export interface CapabilityRecord {
  id: string
  verb: CapabilityVerb
  resource: CapabilityResource
  qualifier?: CapabilityQualifier
  /** Epoch ms; token sudah mati saat `now >= expiresAt`. */
  expiresAt: number
  mintedBy?: string
}

export interface MintOptions {
  verb: CapabilityVerb
  resource: CapabilityResource
  qualifier?: CapabilityQualifier
  /** Default 15 menit, di-clamp ke [1, 60 menit]. */
  ttlMs?: number
  mintedBy?: string
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000
export const MIN_TTL_MS = 1
export const MAX_TTL_MS = 60 * 60 * 1000

const TOKEN_PREFIX = 'wcap_'
const RESOURCE_RE = /^(node|workspace|project):.+$/

/** Clamp TTL; nilai bukan angka berhingga jatuh ke default. */
export function clampTtl(ttlMs?: number): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return DEFAULT_TTL_MS
  return Math.min(Math.max(Math.trunc(ttlMs), MIN_TTL_MS), MAX_TTL_MS)
}

/** True kalau `resource` cocok dengan bentuk yang didukung. */
export function isValidResource(resource: string): boolean {
  return resource === '*' || RESOURCE_RE.test(resource)
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newId(): string {
  return `cap_${randomBytes(8).toString('hex')}`
}

function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/**
 * Resource grant `workspace:<id>` / `project:<id>` juga mencakup turunannya yang
 * ditulis dengan separator `/` (mis. `workspace:ws1/node:n1`). Selain itu harus
 * persis sama; tidak ada pencocokan awalan mentah yang membuat `ws1` cocok `ws10`.
 */
function resourceMatches(grant: CapabilityResource, requested: CapabilityResource): boolean {
  if (grant === requested) return true
  if (grant === '*') return false
  const prefixed = grant.startsWith('workspace:') || grant.startsWith('project:')
  return prefixed && requested.startsWith(`${grant}/`)
}

/**
 * Cwd cocok kalau sama persis dengan prefix atau berada di bawahnya pada batas
 * separator. Tanpa batas ini `/repo/app` akan ikut meloloskan `/repo/application`.
 * Prefix yang sudah berakhir `/` diperlakukan apa adanya.
 */
function cwdPrefixMatches(cwd: string, prefix: string): boolean {
  if (prefix === '') return true
  if (cwd === prefix) return true
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  return cwd.startsWith(base)
}

function qualifierMatches(qualifier: CapabilityQualifier | undefined, ctx: CapabilityContext): boolean {
  if (!qualifier) return true
  if (qualifier.agentIds !== undefined) {
    if (!ctx.agentId || !qualifier.agentIds.includes(ctx.agentId)) return false
  }
  if (qualifier.cwdPrefix !== undefined) {
    if (!ctx.cwd || !cwdPrefixMatches(ctx.cwd, qualifier.cwdPrefix)) return false
  }
  return true
}

/**
 * Cek apakah `record` mengizinkan `verb` atas `resource` untuk konteks tertentu.
 * `*` hanya berlaku untuk `node.read`, dan verb harus sama persis.
 */
export function allows(
  record: CapabilityRecord,
  verb: CapabilityVerb,
  resource: CapabilityResource,
  context: CapabilityContext = {},
): boolean {
  if (record.verb !== verb) return false
  if (!isValidResource(resource)) return false
  if (record.resource === '*') {
    return (
      verb === 'node.read' &&
      isValidResource(resource) &&
      qualifierMatches(record.qualifier, context)
    )
  }
  if (!resourceMatches(record.resource, resource)) return false
  return qualifierMatches(record.qualifier, context)
}

/** Penerbit dan penyimpan capability token. */
export class CapabilityStore {
  private records = new Map<string, CapabilityRecord>()

  /**
   * Terbitkan token baru. Melempar Error kalau verb/resource tidak sah atau `*`
   * dipakai untuk verb selain `node.read`.
   */
  mint(options: MintOptions, now: number = Date.now()): string {
    const { verb, resource } = options
    if (!CAPABILITY_VERBS.includes(verb)) {
      throw new Error(`mint: unknown verb "${verb}"`)
    }
    if (!isValidResource(resource)) {
      throw new Error(`mint: invalid resource "${resource}"`)
    }
    if (resource === '*' && verb !== 'node.read') {
      throw new Error(`mint: resource "*" only allowed for node.read (got "${verb}")`)
    }

    const token = newToken()
    const record: CapabilityRecord = {
      id: newId(),
      verb,
      resource,
      ...(options.qualifier ? { qualifier: { ...options.qualifier } } : {}),
      expiresAt: now + clampTtl(options.ttlMs),
      ...(options.mintedBy ? { mintedBy: options.mintedBy } : {}),
    }
    this.records.set(sha256(token), record)
    return token
  }

  /** Record untuk token yang masih hidup; token asing atau kedaluwarsa -> undefined. */
  verify(token: string, now: number = Date.now()): CapabilityRecord | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const key = sha256(token)
    const record = this.records.get(key)
    if (!record) return undefined
    if (now >= record.expiresAt) {
      this.records.delete(key)
      return undefined
    }
    return record
  }

  /** Revoke satu token. True kalau token memang ada (walau sudah kedaluwarsa). */
  revoke(token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false
    const key = sha256(token)
    const record = this.records.get(key)
    if (!record) return false
    this.records.delete(key)
    return true
  }

  /** Buang semua token kedaluwarsa; mengembalikan jumlah yang dibuang. */
  sweep(now: number = Date.now()): number {
    let removed = 0
    for (const [key, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** Jumlah token yang masih tersimpan (termasuk yang belum di-sweep). */
  size(): number {
    return this.records.size
  }

  clear(): void {
    this.records.clear()
  }
}
