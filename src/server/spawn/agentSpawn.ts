// The single spawn path behind `agent.spawn` (F2-h). Every door (control API, orchestrator worker,
// Central agent host) is a thin adapter that resolves its own command/cwd and calls `spawnAgent`.
// Here, once: nesting-depth fence, per-parent concurrency cap, policy lineage (K3 attenuation),
// `agent.spawn` / `agent.exit` events and a unique display name.
//
// Modelled on Orca: depth fence `shared/nested-worker-depth.ts:4-32` + child depth = parent depth + 1,
// refused when above the max (`main/runtime/orchestration/db/dispatch-creator-evaluation.ts:95-114`);
// concurrency cap `main/runtime/orchestration/coordinator.ts:32,228` (MAX_CONCURRENT_DEFAULT = 4).
// Differences: webterm's default depth is 2 (K3, `policy.store.ts` MAX_LINEAGE note), and the cap is
// per spawning node rather than per coordinator. Root principals (human-ui, central, routine, telegram)
// are depth 0 and not capped here: Central keeps its own per-project caps (controlGuard.ts).
import { randomUUID } from 'node:crypto'
import { uniqueTitle } from '../../shared/nodeTitle'
import { checkSchema } from '../capability/capability.schema'
import { applyProviderEnv, type ProviderEnv } from '../claudeProvider/claudeProvider.model'
import { activeProviderEnv } from '../claudeProvider/claudeProvider.store'
import { type ExecHandle, type ExecSpec, startExec } from '../central/agents/execRunner'
import { eventBus } from '../events/eventBus'
import { recordEvent } from '../events/producers'
import type { AppendEventInput } from '../events/eventModel'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { principalKind, type Principal } from '../policy/policy.model'
import { activePolicy } from '../policy/policy.runtime'
import { createPolicyStore } from '../policy/policy.store'
import { AGENT_SPAWN_CAPABILITY, type AgentSpawnMode } from './agentSpawn.capability'
import { resolveClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import type { ModelPick } from '../models/modelLadder'
import { defaultModelEnv, modelRequest, type ModelEnv } from '../models/modelRequest'

/** Deepest allowed generation: root (0) -> its agents (1) -> their sub-agents (2). */
export const SPAWN_MAX_DEPTH_DEFAULT = 2
/** Live children one node may run at once (Orca coordinator MAX_CONCURRENT_DEFAULT). */
export const SPAWN_MAX_CHILDREN_DEFAULT = 4
/** Headless wall clock when the door gives none. */
export const SPAWN_HEADLESS_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_AGENT_KIND = 'claude'
const TITLE_MAX = 200

export type SpawnDoor = 'control' | 'orchestrator' | 'central' | 'canvas' | 'routine'
export type SpawnDenyCode = 'spawn_invalid' | 'spawn_depth_exceeded' | 'spawn_cap_exceeded'

export interface AgentSpawnRequest {
  /** Defaults to `claude`. */
  kind?: string
  mode: AgentSpawnMode
  parent: Principal
  /** Absolute; PTY without one uses the session default (home). */
  cwd?: string
  workspaceId?: string
  prompt?: string
  title?: string
  /** PTY: the canvas node id (required). Headless: optional stable id for lineage. */
  nodeId?: string
  door: SpawnDoor
  /** PTY launch, resolved by the door from server data (settings, catalog). */
  pty?: { cmd?: string; agentId?: string; sessionId?: string; cols?: number; rows?: number }
  /** Headless launch; `argv` absent = Claude Code print mode with `prompt`, through `claudeProfileId` (absent = default profile). */
  headless?: { argv?: readonly string[]; claudeProfileId?: string; pick?: ModelPick | null; env?: NodeJS.ProcessEnv; overrides?: Record<string, string>; timeoutMs?: number }
}

export interface PtyOpenInput { nodeId: string; cwd?: string; cmd?: string; agentId?: string; sessionId?: string; cols?: number; rows?: number }

/** What the caller's session layer offers; only PTY spawns need it. */
export interface SpawnIo {
  openPty?(input: PtyOpenInput): void | Promise<void>
  input?(nodeId: string, text: string): void
}

export type AgentSpawnResult =
  | { ok: true; childId: Principal; nodeId: string; depth: number; name: string; handle?: ExecHandle }
  | { ok: false; code: SpawnDenyCode; message: string }

export interface AgentSpawnerOptions {
  maxDepth?: number
  maxChildren?: number
  /** Lineage nearest first (policy store); default reads the active ledger, empty without one. */
  ancestors?(p: Principal): Principal[]
  registerSpawn?(parent: Principal, child: Principal): void
  record?(input: AppendEventInput): void
  exec?(spec: ExecSpec): ExecHandle
  /** Registers the PTY exit listener; default listens for `pty.exit` on the event bus. */
  onPtyExit?(fn: (nodeId: string, code: number | null) => void): void
  /** Claude provider env for headless Claude runs; default reads Settings > Capabilities. */
  providerEnv?(): ProviderEnv
}

const hasFlag = (args: readonly string[], flag: string): boolean => args.some((a) => a === flag || a.startsWith(`${flag}=`))

/**
 * `--model`/`--effort` for a ladder pick. A flag the launch profile already sets is kept, unless the pick is
 * the user's explicit override (then ours comes later on the line and wins). A model the user chose for
 * their provider (card or ANTHROPIC_* model vars in `env`) is never overridden (`modelRequest`).
 */
export function modelFlags(profileFlags: readonly string[], pick?: ModelPick | null, env: () => ModelEnv = defaultModelEnv): string[] {
  if (!pick) return []
  const forced = pick.reason === 'user override'
  const flag = pick.model && (forced || !hasFlag(profileFlags, '--model')) ? modelRequest(pick.model, env()).flag : null
  return [
    ...(flag ? ['--model', flag] : []),
    ...(pick.effort && (forced || !hasFlag(profileFlags, '--effort')) ? ['--effort', pick.effort] : []),
  ]
}

/** Claude Code non-interactive form via the launch profile (absent = default), on the ladder's model; JSON result so `execRunner` keeps the final event. */
export function claudeHeadlessArgv(prompt: string, profileId?: string, pick?: ModelPick | null, env?: () => ModelEnv): string[] {
  const launch = resolveClaudeLaunch(profileId)
  return [...launch.argv, '-p', prompt, '--output-format', 'json', ...modelFlags(launch.flags, pick, env)]
}

const isRoot = (p: Principal): boolean => principalKind(p) !== 'node'

function defaultAncestors(p: Principal): Principal[] {
  const ledger = activeLedgerRuntime()
  return ledger ? createPolicyStore(ledger.db, Date.now).ancestors(p) : []
}

interface Live { parent: Principal; depth: number; name: string }

export function createAgentSpawner(opts: AgentSpawnerOptions = {}) {
  const maxDepth = opts.maxDepth ?? SPAWN_MAX_DEPTH_DEFAULT
  const maxChildren = opts.maxChildren ?? SPAWN_MAX_CHILDREN_DEFAULT
  const ancestors = opts.ancestors ?? defaultAncestors
  const register = opts.registerSpawn ?? ((parent: Principal, child: Principal) => activePolicy()?.registerSpawn(parent, child))
  const record = opts.record ?? recordEvent
  const exec = opts.exec ?? startExec
  const providerEnvOf = opts.providerEnv ?? (() => activeProviderEnv())
  const live = new Map<Principal, Live>()

  /** Root = 0. A node is its live depth, else its persisted lineage; an unrecorded node (opened by hand) is 1. */
  function depthOf(p: Principal): number {
    if (isRoot(p)) return 0
    const known = live.get(p)
    if (known) return known.depth
    const chain = [p, ...ancestors(p)]
    return chain.length - 1 + (isRoot(chain[chain.length - 1] as Principal) ? 0 : 1)
  }

  function exited(childId: Principal, code: number | null, reason: string): void {
    const child = live.get(childId)
    if (!child) return
    live.delete(childId)
    record({ kind: 'agent.exit', source: 'spawn', actor: childId, subject: childId, nodeId: childId.slice('node:'.length), trust: 'trusted', payload: { parent: child.parent, code, reason } })
  }

  ;(opts.onPtyExit ?? ((fn) => { eventBus.subscribe('pty.exit', (e) => { if (e.nodeId) fn(e.nodeId, (e.payload as { code?: number } | null)?.code ?? null) }) }))(
    (nodeId, code) => exited(`node:${nodeId}`, code, 'pty_exit')
  )

  async function spawn(raw: AgentSpawnRequest, io: SpawnIo = {}): Promise<AgentSpawnResult> {
    // A door's display title (plan item, task) may run long; it is a label, so clip rather than refuse.
    const req = raw.title === undefined ? raw : { ...raw, title: raw.title.slice(0, TITLE_MAX) }
    const deny = (code: SpawnDenyCode, message: string): AgentSpawnResult => ({ ok: false, code, message })
    const invalid = checkSchema(AGENT_SPAWN_CAPABILITY.input, req)
    if (invalid) return deny('spawn_invalid', invalid)
    if (req.mode === 'pty' && (!req.nodeId || !io.openPty)) return deny('spawn_invalid', 'pty spawn needs a node id and a session layer')
    if (req.mode === 'headless' && (!req.cwd || (!req.headless?.argv && !req.prompt))) return deny('spawn_invalid', 'headless spawn needs a cwd and a prompt')
    const kind = req.kind ?? DEFAULT_AGENT_KIND
    const depth = depthOf(req.parent) + 1
    if (depth > maxDepth) return deny('spawn_depth_exceeded', `Sub-agent spawn is not permitted at depth ${depth} (max ${maxDepth}). Complete this task yourself.`)
    if (!isRoot(req.parent) && [...live.values()].filter((c) => c.parent === req.parent).length >= maxChildren) {
      return deny('spawn_cap_exceeded', `${req.parent} already runs ${maxChildren} agents; wait for one to finish.`)
    }
    const nodeId = req.nodeId ?? `headless-${randomUUID()}`
    const childId: Principal = `node:${nodeId}`
    const name = uniqueTitle(req.title?.trim() || kind, [...live.values()].map((c) => c.name))
    // Reserved before the first await, so concurrent spawns of one parent cannot both pass the cap.
    live.set(childId, { parent: req.parent, depth, name })
    let handle: ExecHandle | undefined
    try {
      if (req.mode === 'pty') {
        await io.openPty?.({ nodeId, ...(req.cwd ? { cwd: req.cwd } : {}), ...req.pty })
        if (req.prompt) io.input?.(nodeId, `${req.prompt}\r`)
      } else {
        const h = req.headless ?? {}
        // Claude provider, as dag.planner: the exec scrub keeps only an allowlist, so the provider vars
        // ride as overrides (applied last, so a door override cannot clobber them) and stale ones are unset.
        const pe = kind === DEFAULT_AGENT_KIND ? providerEnvOf() : { set: {}, unset: [] }
        const env = pe.unset.length ? applyProviderEnv(h.env ?? process.env, { set: {}, unset: pe.unset }) : h.env
        const overrides = { ...h.overrides, ...pe.set }
        handle = exec({ argv: h.argv ?? claudeHeadlessArgv(req.prompt as string, h.claudeProfileId, h.pick, () => applyProviderEnv(h.env ?? process.env, pe)), cwd: req.cwd as string, env, overrides, timeoutMs: h.timeoutMs ?? SPAWN_HEADLESS_TIMEOUT_MS })
      }
    } catch (err) {
      live.delete(childId)
      throw err
    }
    // K3: from now on the child's decisions are capped by its spawner's (lineage persists).
    register(req.parent, childId)
    // Rule 12: ids, kind and shape only; never the prompt, cwd or argv.
    record({ kind: 'agent.spawn', source: 'spawn', actor: req.parent, subject: childId, nodeId, workspaceId: req.workspaceId ?? null, trust: 'trusted', payload: { kind, mode: req.mode, door: req.door, depth, name } })
    void handle?.done.then((o) => exited(childId, o.exitCode, o.timedOut ? 'timeout' : 'exit'))
    return { ok: true, childId, nodeId, depth, name, ...(handle ? { handle } : {}) }
  }

  return {
    spawn,
    /** Live children of `parent` (for status views and tests). */
    childrenOf: (parent: Principal): Principal[] => [...live].filter(([, c]) => c.parent === parent).map(([id]) => id),
    depthOf,
  }
}

export type AgentSpawner = ReturnType<typeof createAgentSpawner>

let shared: AgentSpawner | null = null

/** Process-wide spawner: depth and caps must hold across every door, so they share one. */
export function spawnAgent(req: AgentSpawnRequest, io?: SpawnIo): Promise<AgentSpawnResult> {
  shared ??= createAgentSpawner()
  return shared.spawn(req, io)
}

/** Test hook. */
export function resetAgentSpawnerForTest(next: AgentSpawner | null = null): void {
  shared = next
}
