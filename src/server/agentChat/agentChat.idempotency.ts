// `Idempotency-Key` replay for the agent chat `send` / `fork` verbs: a client that lost the answer
// (connection dropped mid-request) retries with the same key and gets the first answer back instead
// of a second message to Claude. Mirrors Central chat's `clientMessageId` dedupe
// (central/conversationStore.ts `appendMessage`), but in memory: agent chat sends are not rows, the
// Claude transcript is the record. Failed answers (>= 400) are forgotten, so a retry runs again.
// ponytail: in-memory, lost on server restart; a restart also drops the Claude query the send went to.
import type { ServerResponse } from 'node:http'
import { json } from '../routes/route.core'

/** How long an answered key is replayed; far beyond any client retry window. */
export const AGENT_CHAT_IDEMPOTENCY_TTL_MS = 10 * 60_000
/** Keys kept at most (oldest evicted first), so a flood of keys cannot grow memory unbounded. */
export const AGENT_CHAT_IDEMPOTENCY_MAX = 2000
/** Header the client sets; same name as the IETF draft / Stripe. */
export const IDEMPOTENCY_HEADER = 'idempotency-key'
const KEY = /^[A-Za-z0-9_-]{8,128}$/

interface Answer { status: number; body: unknown }

/** The header value when it is a well-formed key; anything else = no dedupe (never a 400). */
export function idempotencyKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const v = headers[IDEMPOTENCY_HEADER]
  return typeof v === 'string' && KEY.test(v) ? v : undefined
}

/** Fake response that records what `json()` writes, so the answer can be stored and replayed. */
function captureRes(): { res: ServerResponse; answer: () => Answer } {
  let status = 200
  let data = ''
  const res = {
    set statusCode(s: number) { status = s },
    get statusCode() { return status },
    setHeader() { return res },
    end(chunk?: string) { data = chunk ?? '' },
  }
  return { res: res as unknown as ServerResponse, answer: () => ({ status, body: data ? JSON.parse(data) as unknown : undefined }) }
}

export interface Idempotency {
  /**
   * Run `handle` once per `scope` + `key`: it answers into the given response; a repeat (even while
   * the first is still running) gets the same answer written to `res`.
   */
  run(res: ServerResponse, scope: string, key: string, handle: (res: ServerResponse) => Promise<unknown>): Promise<true>
}

export function createIdempotency(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): Idempotency {
  const ttlMs = opts.ttlMs ?? AGENT_CHAT_IDEMPOTENCY_TTL_MS
  const max = opts.max ?? AGENT_CHAT_IDEMPOTENCY_MAX
  const now = opts.now ?? Date.now
  const seen = new Map<string, { at: number; answer: Promise<Answer> }>() // insertion order = age

  const prune = (): void => {
    const cutoff = now() - ttlMs
    for (const [k, v] of seen) {
      if (v.at > cutoff && seen.size < max) break
      seen.delete(k)
    }
  }

  return {
    async run(res, scope, key, handle) {
      prune()
      const k = `${scope}\n${key}`
      let entry = seen.get(k)
      if (!entry) {
        const cap = captureRes()
        const answer = handle(cap.res).then(() => cap.answer())
        entry = { at: now(), answer }
        seen.set(k, entry)
        const mine = entry
        // A failed or thrown first attempt must not pin its failure on the retries.
        answer.then((a) => { if (a.status >= 400 && seen.get(k) === mine) seen.delete(k) }, () => { if (seen.get(k) === mine) seen.delete(k) })
      }
      const a = await entry.answer
      json(res, a.status, a.body)
      return true
    },
  }
}
