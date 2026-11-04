// In-process pub/sub for Senses events. Same failure rule as logs/logBus.ts: a throwing
// subscriber is removed and reported to stderr, it never breaks the producer.
import type { SenseEvent } from './eventModel'

export type EventListener = (event: SenseEvent) => void

const PATTERN_RE = /^(\*|[\w-]+(\.[\w-]+)*(\.\*)?)$/

/** `*` = everything, `hook.*` = the `hook.` family (any depth), anything else = exact kind. */
export function kindMatches(pattern: string, kind: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return kind.startsWith(pattern.slice(0, -1))
  return pattern === kind
}

/** Validates a subscription pattern; exported for the SSE `?kind=` boundary. */
export function isKindPattern(pattern: string): boolean {
  return PATTERN_RE.test(pattern)
}

export function createEventBus() {
  const subs = new Set<{ pattern: string; fn: EventListener }>()
  return {
    /** Registers `fn` for kinds matching `kindPattern`; returns the unsubscribe function. */
    subscribe(kindPattern: string, fn: EventListener): () => void {
      if (!isKindPattern(kindPattern)) throw new TypeError(`eventBus.subscribe: invalid kind pattern ${JSON.stringify(kindPattern)}`)
      const sub = { pattern: kindPattern, fn }
      subs.add(sub)
      return () => { subs.delete(sub) }
    },
    publish(event: SenseEvent): void {
      for (const sub of [...subs]) {
        if (!kindMatches(sub.pattern, event.kind)) continue
        try {
          sub.fn(event)
        } catch (err) {
          subs.delete(sub)
          process.stderr.write(`eventBus: subscriber for ${sub.pattern} removed after error on ${event.kind}#${event.seq}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
    },
    get subscriberCount(): number {
      return subs.size
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>

/** Process-wide bus; `wake`, linkNote and the SSE route subscribe here (F1-d). */
export const eventBus = createEventBus()
