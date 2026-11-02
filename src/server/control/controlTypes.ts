// Tipe + helper murni untuk control API headless (P1). Dipisah dari `controlApi.ts` supaya
// handler tetap di bawah batas 300 baris dan test bisa mengimpor kontrak tanpa memuat router.
// Tidak ada impor `Bun`, `node:fs`, atau store di sini — modul ini harus aman di node-env vitest.

import type { OpenMsg, ServerMsg } from '../../shared/protocol'
import type { Settings } from '../../shared/settings'
import type { AgentStatus } from '../../shared/workspace'
import type { CapabilityContext, CapabilityRecord, CapabilityVerb } from './capabilities'

/** Hasil satu route control: `null` = path bukan milik keluarga ini (jatuh ke 404 pemanggil). */
export type ControlResult = { status: number; body?: unknown } | null

export type ControlHeaders = Record<string, string | string[] | undefined>

/** Request minimal, sengaja tidak memakai `IncomingMessage` supaya handler murni & mudah dites. */
export interface ControlRequest {
  method: string
  path: string
  body?: unknown
  headers?: ControlHeaders
}

/** Tombstone exit versi struktural (`NodeExit` di nodeRegistry) — cukup field yang dibutuhkan. */
export interface ControlExit {
  code: number
  reason?: string
  at?: number
}

export interface ControlSessionInfo {
  id: string
  pid?: number
  status?: AgentStatus
}

/** Potongan `Sessions` yang dipakai control plane. Integrator meneruskan objek nyata; test memakai
 *  fake. Semua method sinkron, persis seperti `Sessions`. */
export interface ControlSessions {
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void
  input(id: string, data: string): void
  close(id: string, send?: (m: ServerMsg) => void): void
  list(): ControlSessionInfo[]
  statusOf(id: string): AgentStatus | undefined
  getExit(id: string): ControlExit | undefined
  getTerminal(id: string): string
  isLive(id: string): boolean
}

/** Potongan `CapabilityStore` + `allows`. `mint` opsional: hanya route token yang membutuhkannya. */
export interface ControlCapabilities {
  verify(token: string, now?: number): CapabilityRecord | undefined
  allows(
    record: CapabilityRecord,
    verb: CapabilityVerb,
    resource: string,
    ctx?: CapabilityContext
  ): boolean
  mint?(options: { verb: CapabilityVerb; resource: string; ttlMs?: number }): {
    token: string
    expiresAt: number
  }
}

export interface ControlDeps {
  sessions: ControlSessions
  capabilities: ControlCapabilities
  settings: () => Settings
  /** Token root untuk membuka endpoint mint. Absen = mint selalu 404. */
  rootToken?: string
  /** Gerbang fitur mint; false/absen = endpoint token tidak ada. */
  allowTokenMint?: boolean
  /** Validator cwd opsional (mis. harus di bawah workspace root). Absen = tidak ada batas. */
  cwdAllowed?: (cwd: string) => boolean
  /** Sumber waktu, di-inject supaya ack/idempotensi/expiry bisa dites tanpa jam dinding. */
  now?: () => number
  /** Sumber tidur untuk long-poll `wait`; test memakai sleep palsu yang memajukan `now`. */
  sleep?: (ms: number) => Promise<void>
}

export const CONTROL_PREFIX = '/api/control'

export const REQUEST_ID_MIN = 8
export const REQUEST_ID_MAX = 128
/** Jendela replay ack: requestId yang sama dalam 10 menit tidak menjalankan efek kedua. */
export const ACK_TTL_MS = 10 * 60 * 1000
/** Batas entri ack di proses berumur panjang; yang tertua (urutan insert) dibuang lebih dulu. */
export const ACK_LIMIT = 1000

export const MAX_PROMPT_CHARS = 32_768
/** Batas body request control (byte, bukan karakter) — diperiksa SEBELUM `JSON.parse`. */
export const CONTROL_MAX_BODY_BYTES = 64 * 1024
export const WAIT_MAX_MS = 25_000
export const WAIT_POLL_MS = 100
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

export { headerValue } from '../httpHeaders'

/** Body non-array/non-null sebagai record; selain itu objek kosong (batas input, bukan trust). */
export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function isValidRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= REQUEST_ID_MIN &&
    value.length <= REQUEST_ID_MAX
  )
}

/** Integer positif berhingga dalam rentang, atau undefined kalau tidak sah. */
export function positiveInt(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.trunc(value)
  return n >= 1 && n <= max ? n : undefined
}

/**
 * Kunci ack: verb + resource node + requestId. requestId yang dipakai ulang di route lain TIDAK
 * boleh memutar ulang ack milik route sebelumnya (mis. spawn R lalu close R bukan replay spawn).
 * `nodeId` sudah aman (`isSafeNodeId`), jadi ia tidak bisa memalsukan pemisah kunci.
 */
export function ackKey(verb: CapabilityVerb, nodeId: string, requestId: string): string {
  return `${verb}|node:${nodeId}|${requestId}`
}

/** Acknowledgment idempoten per kunci ack. Di-key oleh `deps` lewat WeakMap di router. */
export class AckStore {
  private acks = new Map<string, { at: number; result: { status: number; body?: unknown } }>()

  constructor(private readonly limit: number = ACK_LIMIT) {}

  get(key: string, now: number): { status: number; body?: unknown } | undefined {
    const entry = this.acks.get(key)
    if (!entry) return undefined
    if (now - entry.at >= ACK_TTL_MS) {
      this.acks.delete(key)
      return undefined
    }
    return entry.result
  }

  set(key: string, result: { status: number; body?: unknown }, now: number): void {
    // Penulisan ulang key yang sudah ada tidak mengubah urutan insert, jadi replay lama tidak
    // memperpanjang umurnya — sama seperti eviction registry node.
    while (this.acks.size >= this.limit) {
      const oldest = this.acks.keys().next().value
      if (oldest === undefined) break
      this.acks.delete(oldest)
    }
    this.acks.set(key, { at: now, result })
  }
}
