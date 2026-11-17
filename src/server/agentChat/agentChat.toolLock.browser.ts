// Strict parser of the second command family a skill-author chat may run: read-only public web research via
// `webterm browser open|navigate|snapshot`. One line, no flags (so no `--node`), at most one URL token, no shell
// syntax of any kind. The server re-checks verb and URL in the browser control handler (browser/browser.presetLock.ts).
import { isPublicWebUrl } from '../browser/browser.publicUrl'

const URL_PLAIN = /^https?:\/\/[A-Za-z0-9._~:/?=%+,@-]+$/
const URL_SINGLE = /^'(https?:\/\/[A-Za-z0-9._~:/?=%+,@&#-]+)'$/
// `snapshot` is the page reader (the CLI has no `read` verb).
const LINE = /^webterm browser (open|navigate|snapshot)(?: (\S+))?$/

/** True when `command` is exactly one allowed `webterm browser` call with a public http(s) URL where one is used. */
export function browserCommandDecision(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const m = LINE.exec(command)
  if (!m) return false
  const [, verb, arg] = m
  if (verb === 'snapshot') return arg === undefined
  if (arg === undefined) return verb === 'open'
  const url = URL_PLAIN.test(arg) ? arg : URL_SINGLE.exec(arg)?.[1]
  return url !== undefined && isPublicWebUrl(url)
}
