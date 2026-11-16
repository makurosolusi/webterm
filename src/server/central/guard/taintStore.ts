// Per-conversation taint: "Central read untrusted web content here" (simplified CaMeL, arXiv 2503.18813: policy is enforced
// at the tool call, untrusted data must not steer control flow). Held in PROCESS MEMORY only, no schema: a restart
// clears every taint (accepted limit: the in-flight conversation history is also short-lived relative to a restart).
// Only ids, origins (scheme://host[:port]) and tool names are kept; never page text or summaries (Rule 12).
import { parseBrowserUrl } from '../../../shared/browser.url'

/** How long a conversation stays tainted after its last untrusted read. guess: the reader summary is short, validated and bounded, so after this the history is treated as already used. */
export const TAINT_TTL_MS = 10 * 60_000
/** Human-facing reason shown on the approval card of a tainted ask. */
export const TAINT_REASON = 'Central read web content in this conversation, so this action needs your OK.'
const MAX_CONVERSATIONS = 200
const MAX_ORIGINS = 50
const MAX_ASKED = 30
const MAX_ID = 200

interface Entry { until: number; origins: Set<string>; asked: Set<string> }
const taints = new Map<string, Entry>()

/** `scheme://host[:port]` of an http(s) url, or null when it does not parse. */
export function originOf(url: unknown): string | null {
  const parsed = parseBrowserUrl(url)
  return parsed.ok ? new URL(parsed.url).origin : null
}

function add(set: Set<string>, value: string, max: number): void {
  set.delete(value)
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value as string)
}

function live(conversationId: string, now: number): Entry | null {
  const e = taints.get(conversationId)
  if (!e) return null
  if (now >= e.until) { taints.delete(conversationId); return null }
  return e
}

/** Marks the conversation tainted (idempotent: a repeat only extends the TTL) and remembers the origin that was read. */
export function markTainted(conversationId: string, origin: string | null, now: number): void {
  const id = conversationId.slice(0, MAX_ID)
  const e = live(id, now) ?? { until: 0, origins: new Set<string>(), asked: new Set<string>() }
  e.until = now + TAINT_TTL_MS
  if (origin) add(e.origins, origin, MAX_ORIGINS)
  taints.delete(id)
  taints.set(id, e)
  if (taints.size > MAX_CONVERSATIONS) taints.delete(taints.keys().next().value as string)
}

/** Origins read while the taint is active, or null when the conversation is not tainted (or the taint expired). */
export function taintedOrigins(conversationId: string, now: number): ReadonlySet<string> | null {
  return live(conversationId.slice(0, MAX_ID), now)?.origins ?? null
}

/** Remembers that `tool` was asked about because of the taint, so the approval card can say why. */
export function noteTaintedAsk(conversationId: string, tool: string, now: number): void {
  const e = live(conversationId.slice(0, MAX_ID), now)
  if (e) add(e.asked, tool, MAX_ASKED)
}

/** True when `tool` raised a tainted ask in this (still tainted) conversation. */
export function wasTaintedAsk(conversationId: string, tool: string, now: number): boolean {
  return live(conversationId.slice(0, MAX_ID), now)?.asked.has(tool) === true
}

/** Forgets every taint (tests and a full reset). */
export function clearTaints(): void { taints.clear() }
