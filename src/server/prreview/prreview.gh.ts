// The `gh` CLI as the PR review bot's only door to GitHub. Preferred auth is gh's own login (no
// token passes through webterm). When `gh auth status` fails, a GH_TOKEN / GITHUB_TOKEN secret from
// the secret broker store is injected into the gh child env only (gh reads GH_TOKEN itself), the way
// the broker hands a secret to the one process that needs it. The value is never logged or returned.
// ponytail: no REST client of our own; without gh there is no review. Add fetch() to api.github.com
// if users without gh ask for it.
import { createBrokerStore } from '../secrets/secret.store'
import { redactSecrets } from '../redactSecrets'
import { run, type RunResult } from '../gitScm'

export const GH_TIMEOUT_MS = 60_000
export const BROKER_TOKEN_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const
const ERR_TAIL = 400

export type GhErrorCode = 'gh_missing' | 'gh_unauthed' | 'gh_failed'
export class GhError extends Error {
  constructor(readonly code: GhErrorCode, message: string) { super(message) }
}

export interface GhOptions {
  /** Source env (PATH decides which gh runs); default process.env. */
  env?: NodeJS.ProcessEnv
  /** Broker secret lookup; default the broker store. */
  readSecret?(name: string): string | null
}

export interface PrInfo { number: number; title: string; url: string; headRefOid: string; baseRefName: string }

export function createGh(opts: GhOptions = {}) {
  const readSecret = opts.readSecret ?? ((name: string) => createBrokerStore().read(name))
  const baseEnv = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) out[k] = v
    return { ...out, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
  }

  /** Per call (a login can change): gh's own login if it works, else the broker token, else a clear refusal. */
  async function authedEnv(cwd: string): Promise<Record<string, string>> {
    const plain = baseEnv()
    const status = await run('gh', ['auth', 'status'], { cwd, env: plain, timeoutMs: GH_TIMEOUT_MS })
    if (status.code === null) throw new GhError('gh_missing', 'The GitHub CLI (gh) is not installed. Install it to review pull requests.')
    if (status.code === 0) return plain
    for (const name of BROKER_TOKEN_NAMES) {
      const token = readSecret(name)
      if (token) return { ...plain, GH_TOKEN: token }
    }
    throw new GhError('gh_unauthed', 'gh is not logged in. Run `gh auth login`, or store a GH_TOKEN secret in Settings > Secrets.')
  }

  async function gh(cwd: string, args: string[], input?: string): Promise<string> {
    const r: RunResult = await run('gh', args, { cwd, env: await authedEnv(cwd), timeoutMs: GH_TIMEOUT_MS, ...(input === undefined ? {} : { input }) })
    if (r.code !== 0) {
      const why = r.timedOut ? 'timed out' : redactSecrets(r.stderr.trim()).slice(-ERR_TAIL)
      throw new GhError('gh_failed', `gh ${args.slice(0, 2).join(' ')} failed: ${why}`)
    }
    return r.stdout
  }

  const json = async <T>(cwd: string, args: string[], input?: string): Promise<T> => {
    const out = await gh(cwd, args, input)
    try { return JSON.parse(out) as T } catch { throw new GhError('gh_failed', `gh ${args.slice(0, 2).join(' ')} returned no JSON`) }
  }

  const PR_FIELDS = 'number,title,url,headRefOid,baseRefName'
  return {
    prView: (cwd: string, pr: number) => json<PrInfo>(cwd, ['pr', 'view', String(pr), '--json', PR_FIELDS]),
    prList: (cwd: string, limit: number) => json<PrInfo[]>(cwd, ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', PR_FIELDS]),
    prDiff: (cwd: string, pr: number) => gh(cwd, ['pr', 'diff', String(pr)]),
    /** POST one review; the payload goes on stdin so nothing large or sensitive rides argv. */
    postReview: (cwd: string, slug: string, pr: number, payload: unknown) =>
      json<{ id?: number; html_url?: string }>(cwd, ['api', '--method', 'POST', `repos/${slug}/pulls/${pr}/reviews`, '--input', '-'], JSON.stringify(payload)),
  }
}

export type Gh = ReturnType<typeof createGh>
