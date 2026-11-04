// One-time Telegram deep-link pairing codes (`https://t.me/<bot>?start=<code>`). The Settings card
// asks for a code bound to one project; the bot receives `/start <code>` from the chat that opened
// the link and binds THAT chat. Pattern from Grafana OnCall (engine/apps/telegram/updates/
// update_handlers/verification/personal.py: `/start <code>` in a private chat -> verify -> link ->
// confirm), tightened: random (crypto), short-lived and single-use, so a stranger cannot guess or
// replay one. Memory-only on purpose: a code lives minutes, a restart just means "get a new link".
import { randomBytes } from 'node:crypto'

/** Telegram `start` parameter rules: [A-Za-z0-9_-], at most 64 chars (core.telegram.org/bots/features#deep-linking). */
export const START_PARAM_SHAPE = /^[A-Za-z0-9_-]{1,64}$/
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const PAIRING_CODE_LIMIT = 20
/** 18 random bytes -> 24 base64url chars (144 bits), inside the 64-char start limit. */
const CODE_BYTES = 18

export interface PairingGrant {
  projectId: string
  projectName: string
}

export interface PairingCodeOptions {
  now?: () => number
  ttlMs?: number
  limit?: number
  random?: (bytes: number) => Buffer
}

/** `/start <code>` (optionally `/start@bot <code>`) -> the code, else null. */
export function startCodeOf(text: string): string | null {
  const m = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)\s*$/.exec(text.trim())
  return m && START_PARAM_SHAPE.test(m[1]!) ? m[1]! : null
}

/** Bounded store of live codes; Map order == issue order, oldest first. */
export class PairingCodes {
  private readonly rows = new Map<string, PairingGrant & { expiresAt: number }>()
  private readonly clock: () => number
  private readonly ttlMs: number
  private readonly limit: number
  private readonly random: (bytes: number) => Buffer

  constructor(options: PairingCodeOptions = {}) {
    this.clock = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS
    this.limit = Math.max(1, options.limit ?? PAIRING_CODE_LIMIT)
    this.random = options.random ?? randomBytes
  }

  /** New code for `grant`; the oldest live code is dropped past `limit`. */
  issue(grant: PairingGrant): { code: string; expiresAt: number } {
    const now = this.clock()
    this.expire(now)
    const code = this.random(CODE_BYTES).toString('base64url')
    const expiresAt = now + this.ttlMs
    this.rows.set(code, { ...grant, expiresAt })
    while (this.rows.size > this.limit) {
      const oldest = this.rows.keys().next().value
      if (oldest === undefined) break
      this.rows.delete(oldest)
    }
    return { code, expiresAt }
  }

  /** Single use: a live code is removed and its grant returned; unknown/expired -> null. */
  redeem(code: string): PairingGrant | null {
    this.expire(this.clock())
    const row = this.rows.get(code)
    if (!row) return null
    this.rows.delete(code)
    return { projectId: row.projectId, projectName: row.projectName }
  }

  private expire(now: number): void {
    for (const [code, row] of this.rows) if (row.expiresAt <= now) this.rows.delete(code)
  }
}
