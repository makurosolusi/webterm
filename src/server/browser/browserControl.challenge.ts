// Agent verbs pause while a node shows a human check (Google /sorry, captcha, Cloudflare). The agent is told once, plainly,
// to hand the page to the user, and after a few more attempts to stop calling the node at all: no retry loop, no solving.
import { HUMAN_VERIFICATION_CODE, HUMAN_VERIFICATION_NEXT, HUMAN_VERIFICATION_STOP_AFTER, HUMAN_VERIFICATION_STOP_NEXT } from '../../shared/browser.challenge'
import type { BrowserChallenge } from '../../shared/browser.challenge'
import type { BrowserHostApi, BrowserVerb } from '../../shared/browser.contract'
import type { ControlResult } from '../control/controlTypes'
import type { LeaseService } from './browserLease.service'

/** Verbs that stay available during a check: reading the node's state, listing tabs, handing the lease back. */
const ALWAYS_OK: ReadonlySet<BrowserVerb> = new Set(['status', 'tabs', 'downloads', 'release'])
const refusals = new Map<string, number>() // nodeId -> verbs refused for the check now on screen

/** The refusal an agent verb gets while `challenge` is shown, or null to let it run. Clears the count once the check is gone. */
export function challengeRefusal(nodeId: string, verb: BrowserVerb, challenge: BrowserChallenge | undefined): ControlResult | null {
  if (!challenge) { refusals.delete(nodeId); return null }
  if (ALWAYS_OK.has(verb)) return null
  const refused = (refusals.get(nodeId) ?? 0) + 1
  refusals.set(nodeId, refused)
  return {
    status: 409,
    body: {
      error: HUMAN_VERIFICATION_CODE, kind: challenge.kind, refused,
      message: 'This page is asking the user to prove they are human. Only the user can complete it.',
      next: refused > HUMAN_VERIFICATION_STOP_AFTER ? HUMAN_VERIFICATION_STOP_NEXT : HUMAN_VERIFICATION_NEXT,
    },
  }
}

/** An agent holding the node lets go the moment a human check appears (the user's turn); returns the unsubscribe. */
export function pauseLeaseOnChallenge(host: Pick<BrowserHostApi, 'onState'>, leases: Pick<LeaseService, 'release'>): () => void {
  return host.onState((s) => { if (s.challenge) leases.release(s.id) })
}
