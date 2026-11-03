// Central Agent v2 boot (WS-19): builds the guard, agent executor, skill/memory/knowledge providers
// and registers the tool groups into the process registry. Returns null unless some CA2 flag is on
// and a ledger exists, so with every flag off nothing here runs and the old behaviour is untouched.
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { BotManager } from '../channels/botManager'
import { dataDir } from '../config'
import { flagOn } from '../envFlag'
import { consumeApproval } from '../ledger/ledgerApproval'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { createLogger } from '../logs'
import { openKnowledgeDb } from '../knowledge/knowledgeStore'
import { createMemoryBlockProvider } from '../memory/memoryBlock'
import { createMemoryFilePort } from '../memory/memoryFilePath'
import { createUserMemoryStore, userMemoryRoot } from '../memory/memoryUserStore'
import { projectRepo, resolveWorktrees, worktreeRoot } from '../orchestratorRunProduction'
import { type SessionsLike, createSessionsPort } from '../orchestrator/workerRuntimeSession'
import { AGENT_CONFIG, type BuiltinAgentId } from '../../shared/workspace'
import { createAgentExecutor, type AgentExecutor } from './agents/agentExecutor'
import { createAgentHost } from './agents/agentHost'
import { resumeApprovedAgents } from './agents/agentResume'
import { createMailDeliver } from './agents/mailDeliver'
import { createMailStore } from './agents/mailStore'
import type { AgentRecord } from './contracts'
import { type SyncControlGuard, createControlGuard } from './guard/controlGuard'
import { activeCa2, setActiveCa2 } from './ca2Active'
import { reconcileTurns } from './chat/turnReconciler'
import { createSkillStore, type SkillAdminStore } from './skills/skillStore'
import { defaultRegistry } from './tools/defaultRegistry'
import { registerCa2Tools, toolsHash } from './tools/registerAll'
import type { SyncMemoryBlockProvider } from './context/contextAssembler'

type Env = Record<string, string | undefined>
const log = createLogger('central.ca2')

/** Every env flag whose `on`/`propose`/`auto` value arms part of CA2; none set = CA2 is inert. */
export const CA2_ARMING_FLAGS = [
  'WEBTERM_CENTRAL_AGENTS', 'WEBTERM_CENTRAL_CHECKPOINT', 'WEBTERM_CENTRAL_SKILLS', 'WEBTERM_CENTRAL_SKILL_PROPOSE',
  'WEBTERM_CENTRAL_BOTS', 'WEBTERM_KNOWLEDGE', 'WEBTERM_AGENT_MAIL', 'WEBTERM_CENTRAL_READ_TOOLS', 'WEBTERM_CENTRAL_MEMORY',
  'WEBTERM_CENTRAL_RELIABILITY',
] as const
const AGENT_MODES = ['propose', 'auto']
const SWEEP_INTERVAL_MS = 2_000
const SKILLS_SUBDIR = join('central', 'skills')
const KNOWLEDGE_FILE = 'knowledge.db'

/** True when any CA2 flag is armed (the agents flag arms on `propose`/`auto`, the others on `on`). */
export function ca2Active(env: Env = process.env): boolean {
  return CA2_ARMING_FLAGS.some((name) => (name === 'WEBTERM_CENTRAL_AGENTS'
    ? AGENT_MODES.includes((env[name] ?? '').trim().toLowerCase())
    : flagOn(env[name])))
}

export interface Ca2BootOptions {
  runtime: LedgerRuntime | null
  sessions: SessionsLike
  env?: Env
  /** Managed bots manager, only present when the bots flag mounted one. */
  bots?: BotManager | null
  dataDirPath?: string
  now?: () => number
  /** Test seam; production uses the process-wide registry. */
  registry?: ReturnType<typeof defaultRegistry>
  /** Test seam: skip the resume timer. */
  noTimer?: boolean
}

/** Live CA2 services shared with the routes and the autonomy boot. */
export interface Ca2Handle {
  db: Database
  env: Env
  now: () => number
  guard: SyncControlGuard
  executor: AgentExecutor | null
  skills: SkillAdminStore | null
  /** Folder root of the skill store (the review route reads proposed drafts from it). */
  skillsRoot: string
  memory: SyncMemoryBlockProvider
  toolNames: string[]
  toolsHash: string
  /** Resolves when the boot sweeps (agent reconcile, turn reconcile) finished. */
  ready: Promise<void>
  /** Whether an agent's process/session still exists (reliability reconciler input). */
  agentAlive(agent: AgentRecord): boolean
  /** Starts approved-but-pending agents now; returns the count started. */
  sweep(): Promise<number>
  stop(): void
}

export { activeCa2, setActiveCa2 }

function launchLineOf(kind: string): string {
  const config = (AGENT_CONFIG as Record<string, { launchCmd: string } | undefined>)[kind as BuiltinAgentId]
  if (!config) throw new Error(`unknown agent kind: ${kind}`)
  return config.launchCmd
}

function buildExecutor(opts: Ca2BootOptions, db: Database, guard: SyncControlGuard, env: Env, now: () => number, dir: string): AgentExecutor | null {
  const deps = { ledger: opts.runtime, dataDir: () => dir }
  const wt = resolveWorktrees(deps, worktreeRoot(deps))
  if (!wt.ok) { log.warn('ca2.worktrees_unavailable', 'agent worktree root unavailable; agents disabled'); return null }
  const host = createAgentHost({ sessions: createSessionsPort(opts.sessions), worktrees: wt.worktrees, repoOf: (id) => projectRepo(db, id), launchLine: launchLineOf })
  return createAgentExecutor({ db, guard, host, now, env })
}

function buildSkills(db: Database, root: string, now: () => number): SkillAdminStore | null {
  try {
    const store = createSkillStore({ db, root, now })
    store.installBuiltins()
    return store
  } catch (err) {
    log.error('ca2.skills_failed', 'skill store unavailable', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Arms CA2; null when inert (flags off or no ledger). Never throws on a partial failure. */
export function bootCa2(opts: Ca2BootOptions): Ca2Handle | null {
  const env = opts.env ?? process.env
  if (!ca2Active(env)) return null
  if (!opts.runtime) { log.warn('ca2.skip', 'Central Agent v2 flags are set but the ledger is off; not starting'); return null }
  const db = opts.runtime.db
  const now = opts.now ?? Date.now
  const dir = opts.dataDirPath ?? dataDir()
  const guard = createControlGuard({ db, now, env })
  const agentsOn = AGENT_MODES.includes((env.WEBTERM_CENTRAL_AGENTS ?? '').trim().toLowerCase())
  const executor = agentsOn ? buildExecutor(opts, db, guard, env, now, dir) : null
  const skills = flagOn(env.WEBTERM_CENTRAL_SKILLS) || flagOn(env.WEBTERM_CENTRAL_SKILL_PROPOSE) ? buildSkills(db, join(dir, SKILLS_SUBDIR), now) : null
  const userStore = createUserMemoryStore(createMemoryFilePort(userMemoryRoot(env, dir)))
  const sessions = createSessionsPort(opts.sessions)
  let kb: Database | null = null
  const nodeOf = (toRef: string): string | null => (toRef.startsWith('agent:') && executor ? executor.store.get(toRef.slice('agent:'.length))?.nodeId ?? null : null)
  const registry = opts.registry ?? defaultRegistry()
  const toolNames = registerCa2Tools(registry, {
    ...(executor ? { executor, deliver: createMailDeliver({ db, store: createMailStore(db, now), port: {
      statusOf: (ref) => { const node = nodeOf(ref); return node ? sessions.statusOf(node) ?? null : null },
      type: (ref, text) => { const node = nodeOf(ref); if (!node || !sessions.isLive(node)) return false; sessions.input(node, `${text}\r`); return true },
    } }) } : {}),
    openKb: () => (kb ??= openKnowledgeDb(join(dir, KNOWLEDGE_FILE))),
    ...(skills ? { skills: () => skills } : {}),
    userStore,
    ...(opts.bots ? { bots: { manager: () => opts.bots ?? null, consumeApproval: (id: string, digest: string) => consumeApproval({ db, now }, id, { digest }) } } : {}),
  }, env)
  const hash = toolsHash(registry)
  const handle: Ca2Handle = {
    db, env, now, guard, executor, skills, skillsRoot: join(dir, SKILLS_SUBDIR), memory: createMemoryBlockProvider(db, { now }) as SyncMemoryBlockProvider, toolNames, toolsHash: hash,
    ready: Promise.resolve(),
    agentAlive: (a) => (a.runner === 'exec' ? false : !!a.nodeId && sessions.isLive(a.nodeId)),
    sweep: () => (executor ? resumeApprovedAgents(db, executor, now) : Promise.resolve(0)),
    stop: () => {},
  }
  handle.ready = (async () => {
    try { reconcileTurns(db, now()) } catch (err) { log.error('ca2.turns_reconcile_failed', 'turn reconcile failed', { error: err instanceof Error ? err.message : String(err) }) }
    try { await executor?.reconcile() } catch (err) { log.error('ca2.agents_reconcile_failed', 'agent reconcile failed', { error: err instanceof Error ? err.message : String(err) }) }
  })()
  if (executor && !opts.noTimer) {
    const timer = setInterval(() => { handle.sweep().catch((err) => log.error('ca2.sweep_failed', 'approved-agent sweep failed', { error: err instanceof Error ? err.message : String(err) })) }, SWEEP_INTERVAL_MS)
    timer.unref()
    handle.stop = () => clearInterval(timer)
  }
  setActiveCa2(handle)
  log.info('ca2.start', 'Central Agent v2 armed', { tools: toolNames.length, agents: executor !== null, skills: skills !== null, toolsHash: hash.slice(0, 12) })
  return handle
}
