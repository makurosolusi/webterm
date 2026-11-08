// Central Agent v2 boot (WS-19): builds the guard, agent executor, skill/memory/knowledge providers
// and registers the tool groups into the process registry. Returns null unless some CA2 flag is on
// and a ledger exists, so with every flag off nothing here runs and the old behaviour is untouched.
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { BotManager } from '../channels/botManager'
import { dataDir } from '../config'
import { flagOn } from '../envFlag'
import { isEnabled, onCapabilityChange } from '../featureCapabilities.runtime'
import { capabilityStore } from '../control/mount'
import { consumeApproval } from '../ledger/ledgerApproval'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { createLogger } from '../logs'
import { openKnowledgeDb } from '../knowledge/knowledgeStore'
import { createMemoryBlockProvider } from '../memory/memoryBlock'
import { createMemoryFilePort } from '../memory/memoryFilePath'
import { createUserMemoryStore, userMemoryRoot } from '../memory/memoryUserStore'
import { projectRepo, resolveWorktrees, worktreeRoot } from '../orchestratorRunProduction'
import { type SessionsLike, createSessionsPort } from '../orchestrator/workerRuntimeSession'
import { DERIVED_FLAGS } from '../../shared/featureCapabilities'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { getCanvasPush } from '../canvas/canvasPush.runtime'
import { type BrowserBootSources, createBrowserToolDeps } from './ca2Boot.browser'
import { createAgentExecutor, type AgentExecutor } from './agents/agentExecutor'
import { type AgentCatalog, createAgentCatalog, DEFAULT_DENY_ROOTS } from './agents/agentCatalog'
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
import { createAgentKindsDef } from './tools/defs/agentKinds.defs'
import { registerCa2Tools, toolsHash } from './tools/registerAll'
import type { ToolRegistry } from './tools/toolTypes'
import type { SyncMemoryBlockProvider } from './context/contextAssembler'

type Env = Record<string, string | undefined>
const log = createLogger('central.ca2')

const AGENT_MODES = ['propose', 'auto']
const SWEEP_INTERVAL_MS = 2_000
const SKILLS_SUBDIR = join('central', 'skills')
const KNOWLEDGE_FILE = 'knowledge.db'
// Kunci turunan Central (chat, memori, tool baca): tak punya saklar sendiri, ikut Central (ENVSIMPLE D5).
const CENTRAL_DERIVED = DERIVED_FLAGS.filter((d) => d.needs.length === 1 && d.needs[0] === 'central').map((d) => [d.key, 'on'])

/** CA2 aktif = Central on; semua anak CA2 (flag rilis, tuning) hanya berlaku di bawah Central. */
export function ca2Active(env: Env = process.env): boolean { return isEnabled('central', env) }

/** Env efektif untuk merakit CA2: kosong saat Central off, kunci turunan menyala saat on. */
export const effectiveEnv = (env: Env): Env => (ca2Active(env) ? { ...env, ...Object.fromEntries(CENTRAL_DERIVED) } : {})

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
  /** Test seam: capability store + browser runtime lookup for the browser tools (default: process singletons). */
  browser?: BrowserBootSources
  /** User settings for launch overrides (`agentLaunchCommands`, `customAgents`); absent = defaults, i.e. no overrides. */
  settings?: () => Settings
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
  /** The registry the tool groups were registered into (the process-wide one in production). */
  registry: ToolRegistry
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

function buildExecutor(opts: Ca2BootOptions, db: Database, guard: SyncControlGuard, env: Env, now: () => number, dir: string): { executor: AgentExecutor; catalog: AgentCatalog } | null {
  const deps = { ledger: opts.runtime, dataDir: () => dir }
  const wt = resolveWorktrees(deps, worktreeRoot(deps))
  if (!wt.ok) { log.warn('ca2.worktrees_unavailable', 'agent worktree root unavailable; agents disabled'); return null }
  const catalog = createAgentCatalog({ settings: opts.settings ?? (() => DEFAULT_SETTINGS), denyRoots: () => [...DEFAULT_DENY_ROOTS, worktreeRoot(deps)] })
  const host = createAgentHost({ sessions: createSessionsPort(opts.sessions), worktrees: wt.worktrees, repoOf: (id) => projectRepo(db, id), catalog, canvas: getCanvasPush() })
  return { executor: createAgentExecutor({ db, guard, host, now, env }), catalog }
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

/** Merakit CA2 sekali (dormant); Central on/off lewat `onCapabilityChange` menyalakan atau memadamkan tanpa rebuild. Null hanya tanpa ledger. */
export function bootCa2(opts: Ca2BootOptions): Ca2Handle | null {
  const env = opts.env ?? process.env
  if (!opts.runtime) { if (ca2Active(env)) log.warn('ca2.skip', 'Central is on but the ledger is off; Central Agent v2 not starting'); return null }
  const db = opts.runtime.db
  const now = opts.now ?? Date.now
  const dir = opts.dataDirPath ?? dataDir()
  const guard = createControlGuard({ db, now, env, skipApprovals: () => opts.settings?.().skipApprovals === true })
  const userStore = createUserMemoryStore(createMemoryFilePort(userMemoryRoot(env, dir)))
  const sessions = createSessionsPort(opts.sessions)
  let kb: Database | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let armed = false
  // Crash recovery runs once per process: a re-arm (Central off -> on) must not sweep turns this process is still running.
  let turnsReconciled = false
  let built: ReturnType<typeof buildExecutor> | undefined
  const registry = opts.registry ?? defaultRegistry()
  const handle: Ca2Handle = {
    db, env, now, guard, executor: null, skills: null, skillsRoot: join(dir, SKILLS_SUBDIR), memory: createMemoryBlockProvider(db, { now }) as SyncMemoryBlockProvider, registry, toolNames: [], toolsHash: toolsHash(registry),
    ready: Promise.resolve(),
    agentAlive: (a) => (a.runner === 'exec' ? false : !!a.nodeId && sessions.isLive(a.nodeId)),
    sweep: () => (handle.executor ? resumeApprovedAgents(db, handle.executor, now) : Promise.resolve(0)),
    stop: () => {},
  }
  const nodeOf = (toRef: string): string | null => (toRef.startsWith('agent:') && handle.executor ? handle.executor.store.get(toRef.slice('agent:'.length))?.nodeId ?? null : null)
  // Idempoten: start dua kali = satu perakitan; executor/skill dipakai ulang, tool yang sudah terdaftar dilewati.
  const start = (): void => {
    if (armed || !ca2Active(env)) return
    armed = true
    const eff = effectiveEnv(env)
    if (AGENT_MODES.includes((eff.WEBTERM_CENTRAL_AGENTS ?? '').trim().toLowerCase())) built ??= buildExecutor(opts, db, guard, eff, now, dir)
    handle.executor = built?.executor ?? null
    // Re-read on every (re)start: the Settings switch for Central skills bounces Central, so on and off both apply live.
    handle.skills = flagOn(eff.WEBTERM_CENTRAL_SKILLS) || flagOn(eff.WEBTERM_CENTRAL_SKILL_PROPOSE) ? handle.skills ?? buildSkills(db, handle.skillsRoot, now) : null
    const { executor, skills } = handle
    const browser = createBrowserToolDeps(eff, opts.browser ?? { store: capabilityStore })
    handle.toolNames.push(...registerCa2Tools(registry, {
      ...(executor ? { executor, deliver: createMailDeliver({ db, store: createMailStore(db, now), port: {
        statusOf: (ref) => { const node = nodeOf(ref); return node ? sessions.statusOf(node) ?? null : null },
        type: (ref, text) => { const node = nodeOf(ref); if (!node || !sessions.isLive(node)) return false; sessions.input(node, `${text}\r`); return true },
      } }) } : {}),
      openKb: () => (kb ??= openKnowledgeDb(join(dir, KNOWLEDGE_FILE))),
      ...(skills ? { skills: () => skills } : {}),
      userStore,
      ...(browser ? { browser } : {}),
      ...(opts.bots ? { bots: { manager: () => opts.bots ?? null, consumeApproval: (id: string, digest: string) => consumeApproval({ db, now }, id, { digest }) } } : {}),
    }, eff))
    // `agent.kinds` is registered here (not in registerAll) because it needs the catalog built with the executor.
    if (built && !registry.get('agent.kinds')) { registry.register(createAgentKindsDef(built.catalog)); handle.toolNames.push('agent.kinds') }
    handle.toolsHash = toolsHash(registry)
    const reconcileBoot = !turnsReconciled
    turnsReconciled = true
    handle.ready = (async () => {
      if (reconcileBoot) try { reconcileTurns(db, now()) } catch (err) { log.error('ca2.turns_reconcile_failed', 'turn reconcile failed', { error: err instanceof Error ? err.message : String(err) }) }
      try { await executor?.reconcile() } catch (err) { log.error('ca2.agents_reconcile_failed', 'agent reconcile failed', { error: err instanceof Error ? err.message : String(err) }) }
    })()
    if (executor && !opts.noTimer) {
      timer = setInterval(() => { handle.sweep().catch((err) => log.error('ca2.sweep_failed', 'approved-agent sweep failed', { error: err instanceof Error ? err.message : String(err) })) }, SWEEP_INTERVAL_MS)
      timer.unref()
    }
    setActiveCa2(handle)
    log.info('ca2.start', 'Central Agent v2 armed', { tools: handle.toolNames.length, agents: executor !== null, skills: skills !== null, toolsHash: handle.toolsHash.slice(0, 12) })
  }
  // Padam: rute/chat kembali 404 (handle dilepas); tool yang terdaftar tetap, tak terjangkau tanpa chat Central.
  const pause = (): void => {
    if (!armed) return
    armed = false
    if (timer) clearInterval(timer)
    timer = null
    if (activeCa2() === handle) setActiveCa2(null)
  }
  const unhook = onCapabilityChange('central', { start, stop: pause })
  handle.stop = () => { pause(); unhook() }
  if (ca2Active(env)) start()
  return handle
}
