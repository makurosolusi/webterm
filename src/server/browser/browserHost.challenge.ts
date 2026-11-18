// Tracks whether a node's page is an "are you human?" check (shared/browser.challenge.ts) and remembers when the
// user said "I'm done", so the node does not flag the same page again. Judged on every url/title change of the node.
import { detectChallenge } from '../../shared/browser.challenge'
import type { BrowserChallenge } from '../../shared/browser.challenge'
import type { BrowserState } from '../../shared/browser.contract'

export interface ChallengeTracker {
  /** `part` plus the node's `challenge` whenever the part moves its url or title; untouched otherwise. Keeps the old object when nothing changed. */
  apply(cur: BrowserState, part: Partial<BrowserState>): Partial<BrowserState>
  /** The user finished the check: the current challenge page stays unflagged until the node leaves it. Returns the part to patch, or null if none is shown. */
  dismiss(cur: BrowserState): Partial<BrowserState> | null
}

const same = (a: BrowserChallenge | undefined, b: BrowserChallenge | undefined): boolean => a?.kind === b?.kind && a?.url === b?.url

export function createChallengeTracker(): ChallengeTracker {
  const dismissed = new Map<string, string>() // nodeId -> challenge url the user already completed
  return {
    apply(cur, part) {
      if (!('url' in part) && !('title' in part)) return part
      const next = { ...cur, ...part }
      const found = detectChallenge(next.url, next.title) ?? undefined
      if (!found) dismissed.delete(cur.id)
      const shown = found && dismissed.get(cur.id) === found.url ? undefined : found
      return { ...part, challenge: same(shown, cur.challenge) ? cur.challenge : shown }
    },
    dismiss(cur) {
      if (!cur.challenge) return null
      dismissed.set(cur.id, cur.challenge.url)
      return { challenge: undefined }
    },
  }
}
