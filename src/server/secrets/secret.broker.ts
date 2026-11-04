// Secret broker (plan F2-f): agents USE secrets without ever seeing them. Imitates 1Password `op run`
// (developer.1password.com/docs/cli/reference/commands/run: secrets are injected as env vars into the
// one child process and "concealed" in its stdout/stderr) and git credential helpers (the value goes
// to the process that needs it, git-scm.com/docs/gitcredentials), gated like Cursor's sudo prompt:
// every secret is decided per use by policy, R2, `ask` for nodes until a human writes a grant.
// Policy resource per secret: `secret:<NAME>:<argv joined by spaces>`, so a grant scope
// `secret:NPM_TOKEN:npm publish*` lets that node use NPM_TOKEN for `npm publish ...` only.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import type { Receipt } from '../capability/capability.receipt'
import { findWorkspaceFor } from '../contextLinkRoute'
import { activeEventLog } from '../events/eventsRuntime'
import type { EventLog } from '../events/eventLog'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import type { Policy } from '../policy/policy.decide'
import { principalKind, type Grant, type Principal } from '../policy/policy.model'
import { activePolicy } from '../policy/policy.runtime'
import { SECRET_ENV_NAMES } from '../redactSecrets'
import { maskSecrets } from './secret.redact'
import { createBrokerStore, lastUsedByName, SECRET_SUBJECT_PREFIX, SECRET_USE_EVENT, type BrokerStore } from './secret.store'

export const SECRET_RUN_TIMEOUT_MS = 120_000
/** Per stream; the rest is dropped and `truncated` is set. */
export const SECRET_OUTPUT_MAX_BYTES = 128 * 1024
/** Joined argv cap: the policy resource rides the decision event subject (512 chars max). */
export const SECRET_COMMAND_MAX_CHARS = 400
const DENY_NEXT = 'Only the user can grant this secret (Settings > Control > Policy rules); do not retry.'

export interface BrokerDeps {
  policy?: () => Pick<Policy, 'decide'> | null
  workspaces?: () => readonly Workspace[] | Promise<readonly Workspace[]>
  store?: BrokerStore
  events?: () => Pick<EventLog, 'append'> | null
  lastUsed?: () => Map<string, number>
}

type Out = { receipt: Receipt; data?: unknown }
const result = (outcome: Receipt['outcome'], detail: string, evidence: Record<string, unknown> = {}, next: string | null = null): Out =>
  ({ receipt: { outcome, detail, next, evidence, operationId: null } })

/** Nodes are asked by default (builtin slot: any human rule written later wins, last match). */
const askByDefault = (principal: Principal): Grant[] => principalKind(principal) !== 'node' ? [] : [{
  id: 'secret-ask-default', subject: principal, capability: 'secret.run', scope: '*', effect: 'ask',
  expiresAt: null, origin: 'builtin', createdBy: 'human-ui', createdAt: 0,
}]
/** Names only: open to every node, like MCP R0 reads (mcp.tools.ts readGrants). */
const listByDefault = (principal: Principal): Grant[] => [{
  id: 'secret-list-default', subject: principal, capability: 'secret.list', scope: '*', effect: 'allow',
  expiresAt: null, origin: 'builtin', createdBy: 'human-ui', createdAt: 0,
}]

async function boardOf(deps: BrokerDeps): Promise<readonly Workspace[]> {
  if (deps.workspaces) return deps.workspaces()
  const { db } = await import('../db') // lazy: bun:sqlite stays out of vitest imports
  return db.list()
}

function defaultLastUsed(): Map<string, number> {
  const ledger = activeLedgerRuntime()
  return ledger ? lastUsedByName(ledger.db) : new Map()
}

/** Working folder for the run: a node stays inside its own folder; the human picks any. */
async function cwdFor(deps: BrokerDeps, principal: Principal, asked: unknown): Promise<string | Out> {
  const nodeId = principalKind(principal) === 'node' ? principal.slice('node:'.length) : null
  if (!nodeId) return typeof asked === 'string' && asked !== '' ? resolve(asked) : homedir()
  const ws = findWorkspaceFor([...(await boardOf(deps))], nodeId)
  const base = ws?.nodes.find((n) => n.id === nodeId)?.cwd ?? ws?.cwd
  if (!base) return result('denied', 'no_cwd', {}, 'this node has no working folder on the canvas')
  const cwd = resolve(base, typeof asked === 'string' ? asked : '.')
  if (cwd !== resolve(base) && !cwd.startsWith(resolve(base) + sep)) return result('denied', 'outside_cwd', {}, 'pass a cwd inside this node working folder')
  return cwd
}

interface RunOutput { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }

/** Runs argv without a shell; output capped per stream, killed at `timeoutMs`. */
function runChild(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunOutput | { spawnError: string }> {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const size = { stdout: 0, stderr: 0 }
    let truncated = false
    let timedOut = false
    for (const k of ['stdout', 'stderr'] as const) {
      child[k].on('data', (c: Buffer) => {
        const room = SECRET_OUTPUT_MAX_BYTES - size[k]
        if (c.length > room) truncated = true
        if (room > 0) { bufs[k].push(c.subarray(0, room)); size[k] += Math.min(room, c.length) }
      })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', (err: NodeJS.ErrnoException) => { clearTimeout(timer); done({ spawnError: err.code ?? 'spawn_failed' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ exitCode: code, stdout: Buffer.concat(bufs.stdout).toString('utf8'), stderr: Buffer.concat(bufs.stderr).toString('utf8'), timedOut, truncated })
    })
  })
}

async function runSecret(deps: BrokerDeps, args: Record<string, unknown>, principal: Principal): Promise<Out> {
  const names = args.names as string[]
  const argv = args.command as string[]
  if (names.length === 0 || new Set(names).size !== names.length) return result('error', 'invalid_shape', { problem: '$.names: non-empty, no repeats' })
  if (argv.length === 0 || argv[0] === '') return result('error', 'invalid_shape', { problem: '$.command: non-empty argv' })
  const line = argv.join(' ')
  if (line.length > SECRET_COMMAND_MAX_CHARS) return result('error', 'command_too_long', { max: SECRET_COMMAND_MAX_CHARS })

  const policy = (deps.policy ?? activePolicy)()
  if (!policy && principal !== 'human-ui') return result('denied', 'policy_unavailable', {}, 'the webterm ledger is off; only the user can turn it on')
  for (const name of names) {
    const d = policy?.decide(principal, 'secret.run', { resource: `${SECRET_SUBJECT_PREFIX}${name}:${line}`, cable: askByDefault(principal) })
    if (d && d.effect !== 'allow') {
      return result('denied', d.effect === 'ask' ? 'approval_required' : 'policy_denied', { name, reason: d.reason, ...(d.ruleId ? { ruleId: d.ruleId } : {}) }, DENY_NEXT)
    }
  }

  const store = deps.store ?? createBrokerStore()
  const injected: Record<string, string> = {}
  for (const name of names) {
    const value = store.read(name)
    if (value === null) return result('error', 'unknown_secret', { name }, 'secret.list shows the secret names that exist')
    injected[name] = value
  }
  const cwd = await cwdFor(deps, principal, args.cwd)
  if (typeof cwd !== 'string') return cwd

  // The child gets the server env minus every server and broker secret, plus exactly the granted ones.
  const allNames = store.names()
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of [...SECRET_ENV_NAMES, ...allNames]) delete env[k]
  Object.assign(env, injected)
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : SECRET_RUN_TIMEOUT_MS
  const out = await runChild(argv, cwd, env, timeoutMs)
  if ('spawnError' in out) return result('error', 'spawn_failed', { code: out.spawnError })

  // Mask every broker value, not only the injected ones: a command could read another secret's file.
  const values = [...Object.values(injected), ...allNames.filter((n) => !(n in injected)).map((n) => store.read(n)).filter((v): v is string => !!v)]
  const data = { ...out, stdout: maskSecrets(out.stdout, values), stderr: maskSecrets(out.stderr, values) }
  const commandHash = createHash('sha256').update(line).digest('hex')
  const events = (deps.events ?? activeEventLog)()
  const nodeId = principalKind(principal) === 'node' ? principal.slice('node:'.length) : null
  const seqs = names.map((name) => events?.append({
    kind: SECRET_USE_EVENT, source: 'secrets', actor: principal, subject: `${SECRET_SUBJECT_PREFIX}${name}`, nodeId, trust: 'trusted',
    payload: { name, commandHash, exitCode: out.exitCode, timedOut: out.timedOut },
  }).event.seq).filter((s) => s !== undefined)
  const r = result('ok', 'ok', { names, commandHash, exitCode: out.exitCode, ...(seqs.length ? { eventSeqs: seqs } : {}) })
  return { ...r, data }
}

function listSecrets(deps: BrokerDeps, principal: Principal): Out {
  const policy = (deps.policy ?? activePolicy)()
  if (!policy && principal !== 'human-ui') return result('denied', 'policy_unavailable', {}, 'the webterm ledger is off; only the user can turn it on')
  const d = policy?.decide(principal, 'secret.list', { cable: listByDefault(principal) })
  if (d && d.effect !== 'allow') return result('denied', d.effect === 'ask' ? 'approval_required' : 'policy_denied', { reason: d.reason }, DENY_NEXT)
  const used = (deps.lastUsed ?? defaultLastUsed)()
  const secrets = (deps.store ?? createBrokerStore()).names().map((name) => ({ name, lastUsedAt: used.get(name) ?? null }))
  return { ...result('ok', 'ok', { count: secrets.length }), data: { secrets } }
}

/** Runs a `secret.*` capability for the proven `principal` (input already schema-checked). */
export async function runSecretCapability(deps: BrokerDeps, name: string, args: Record<string, unknown>, principal: Principal): Promise<Out> {
  if (name === 'secret.run') return runSecret(deps, args, principal)
  if (name === 'secret.list') return listSecrets(deps, principal)
  return result('error', 'unknown_capability', { name })
}
