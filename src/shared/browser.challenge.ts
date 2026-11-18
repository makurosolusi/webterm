// "Are you human?" pages (Google /sorry, reCAPTCHA, hCaptcha, Cloudflare). Webterm does not solve or sidestep them:
// the node says so, the agent stops, and the person completes the check in the node. Pure, shared by server and client.
// Only the main-frame URL and title are judged: a captcha widget inside an ordinary form is not a blocked page.

export const CHALLENGE_KINDS = ['google_unusual_traffic', 'recaptcha', 'hcaptcha', 'cloudflare', 'human_check'] as const
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number]
/** `url` is origin + path only: the query of a /sorry page carries the user's search terms. */
export interface BrowserChallenge { kind: ChallengeKind; url: string }

/** Error code an agent verb answers with while the node shows a challenge. */
export const HUMAN_VERIFICATION_CODE = 'human_verification_required'
export const HUMAN_VERIFICATION_NEXT = 'Ask the user to solve the check in the browser node, then continue; do not retry.'
/** After this many refused verbs on one challenge the reply tells the agent to stop calling browser verbs at all. */
export const HUMAN_VERIFICATION_STOP_AFTER = 3
export const HUMAN_VERIFICATION_STOP_NEXT = 'Stop calling browser verbs on this node. Tell the user the page needs a human check; wait until they say it is done.'
/** Banner copy (product text, English). */
export const CHALLENGE_BANNER = {
  text: "This site is checking that you're human. Solve it here; agents are paused until you continue.",
  done: "I'm done",
  doneLabel: 'I have completed the human check; let agents continue',
} as const

const GOOGLE_HOST = /(^|\.)google\.(com|co\.[a-z]{2,3}|[a-z]{2,3})$/
const RECAPTCHA_HOST = /(^|\.)recaptcha\.net$/
const TITLE_CLOUDFLARE = /^(just a moment\.{0,3}|attention required! \| cloudflare)$/i
const TITLE_HUMAN = /^(please )?(verify (that )?you(?:'| a)re (a )?human|are you a robot\??|human verification( required)?|unusual traffic from your computer network)/i

/** Which challenge the page at `url` (with `title`) is, or null for an ordinary page. */
export function detectChallenge(url: string, title = ''): BrowserChallenge | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const path = u.pathname
  const at = (kind: ChallengeKind): BrowserChallenge => ({ kind, url: `${u.origin}${path}` })
  if (GOOGLE_HOST.test(host) && /^\/sorry(\/|$)/.test(path)) return at('google_unusual_traffic')
  if ((GOOGLE_HOST.test(host) || RECAPTCHA_HOST.test(host)) && /^\/recaptcha\//.test(path)) return at('recaptcha')
  if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) return at('hcaptcha')
  if (host === 'challenges.cloudflare.com' || path.startsWith('/cdn-cgi/challenge-platform')) return at('cloudflare')
  const t = title.trim()
  if (TITLE_CLOUDFLARE.test(t)) return at('cloudflare')
  if (TITLE_HUMAN.test(t)) return at('human_check')
  return null
}
