// Agent kind catalog (CA-02): the single place that turns a kind id into launch line, headless argv,
// spawn tier and child env. Builtins keep tier R2; a custom agent is visible to central only with
// `centralSpawn === true` and then costs a human approval (R3) on every spawn. The model supplies a kind
// id and a prompt, never a program, argv or env: everything else comes from user settings.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import { canonicalDefJson, type CustomAgent } from '../../../shared/customAgent.schema'
import type { Settings } from '../../../shared/settings'
import { AGENT_CONFIG, customLaunchCmd, type BuiltinAgentId } from '../../../shared/workspace'
import { binaryExists } from '../../ptyShell'
import { claudeProfileLine } from '../../../shared/claudeLaunch/claudeLaunch.builtin'
import { shq } from '../../hooksQuote'
import type { Tier } from '../contracts'

/** Stable error code for a spawn of a kind that is neither builtin nor a custom agent opened to central. */
export const AGENT_KIND_UNKNOWN = 'agent_kind_unknown'

const PROMPT_PLACEHOLDER = '{prompt}'
const SESSION_PLACEHOLDER = '{sessionId}'
const ENV_REF = /^\$\{env:([A-Z][A-Z0-9_]{0,63})\}$/
const RESERVED_ENV = /^(WEBTERM_|NODETERM_)/
const DEF_HASH_HEX_CHARS = 12
const LABEL_MAX = 40
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
/** Program paths under these roots are agent-writable, so a custom program may not live there. */
export const DEFAULT_DENY_ROOTS: readonly string[] = ['/tmp', '/private/tmp']

export interface CatalogEntry {
  kind: string
  builtin: boolean
  /** Interactive (PTY) launch line. */
  launchLine: string
  /** Headless argv with the prompt as exactly one element, or null when the kind has no headless form. */
  headlessArgv: ((prompt: string) => readonly string[]) | null
  /** Resume argv template (contains `{sessionId}`); only set when the custom agent declares one. */
  resumeArgs?: readonly string[]
  tier: Extract<Tier, 'R2' | 'R3'>
  /** sha256 prefix of the canonical definition (custom only); changes when program/args/env change. */
  defHash?: string
  /** Resolves env for the child on demand. Never serialised; values must not reach GET, log or audit. */
  childEnv(): Record<string, string>
}

export interface KindView { id: string; label: string; builtin: boolean; headless: boolean }

export interface AgentCatalog {
  /** Entry for a kind, or null when unknown, not opened to central, or its program is unusable. */
  resolve(kind: string): CatalogEntry | null
  /** Model-safe list of spawnable kinds: no argv, no env. */
  kinds(): KindView[]
}

export interface CatalogDeps {
  settings: () => Settings
  /** Source of `${env:NAME}` values; default `process.env`. */
  env?: () => NodeJS.ProcessEnv
  /** Absolute roots a custom program may not live under (add the worktree root); default `/tmp`. */
  denyRoots?: () => readonly string[]
}

const clean = (s: string): string => s.replace(CONTROL_CHARS, '').slice(0, LABEL_MAX)
const hasPlaceholder = (s: string): boolean => s.includes(PROMPT_PLACEHOLDER) || s.includes(SESSION_PLACEHOLDER)

/** True when `program` is a bare name found on PATH, or an absolute path outside every denied root. */
function programUsable(program: string, deny: readonly string[]): boolean {
  if (!binaryExists(program)) return false
  if (!program.startsWith('/')) return true
  let real: string
  try { real = realpathSync(program) } catch { return false } // vanished between the check and here: unusable
  return !deny.some((root) => { const r = realRoot(root); return real === r || real.startsWith(r + sep) })
}

/** Deny root with symlinks resolved (so `/tmp` and `/private/tmp` both match); falls back to the lexical path when absent. */
function realRoot(root: string): string {
  const abs = resolvePath(root)
  try { return realpathSync(abs) } catch { return abs } // root need not exist: a lexical match is still correct
}

/** Shell line for the PTY path: argv elements quoted one by one; elements needing a placeholder value are dropped. */
function argvLine(program: string, args: readonly string[]): string {
  return [program, ...args.filter((a) => !hasPlaceholder(a))].map(shq).join(' ')
}

function headlessOf(launch: NonNullable<CustomAgent['launch']>): CatalogEntry['headlessArgv'] {
  const tail = launch.headlessArgs
  if (!tail) return null
  // CA-01 guarantees exactly one element equal to `{prompt}`; the prompt is substituted whole, never spliced.
  return (prompt) => [launch.program, ...tail.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a))]
}

function customEntry(agent: CustomAgent, s: Settings, deps: CatalogDeps): CatalogEntry | null {
  const launch = agent.launch
  if (launch && !programUsable(launch.program, deps.denyRoots?.() ?? DEFAULT_DENY_ROOTS)) return null
  // A claude-based custom agent without its own command inherits the default launch profile.
  const line = launch ? argvLine(launch.program, launch.args ?? []) : customLaunchCmd(agent, { claude: claudeProfileLine(s) })
  if (!line) return null
  const refs = agent.env ?? {}
  return {
    kind: agent.id, builtin: false, launchLine: line, tier: 'R3',
    headlessArgv: launch ? headlessOf(launch) : null,
    ...(launch?.resumeArgs ? { resumeArgs: launch.resumeArgs } : {}),
    defHash: createHash('sha256').update(canonicalDefJson(agent)).digest('hex').slice(0, DEF_HASH_HEX_CHARS),
    childEnv() {
      const source = deps.env?.() ?? process.env
      const out: Record<string, string> = {}
      for (const [name, raw] of Object.entries(refs)) {
        const ref = ENV_REF.exec(raw)
        const value = ref ? (RESERVED_ENV.test(ref[1] as string) ? undefined : source[ref[1] as string]) : raw
        if (value !== undefined) out[name] = value
      }
      return out
    },
  }
}

/** Builds the catalog over live settings (read on every call, so edits apply without a restart). */
export function createAgentCatalog(deps: CatalogDeps): AgentCatalog {
  const settings = deps.settings
  function resolve(kind: string): CatalogEntry | null {
    const s = settings()
    // claude (the only builtin) launches through the default launch profile.
    if (kind === 'claude') return { kind, builtin: true, tier: 'R2', launchLine: claudeProfileLine(s), headlessArgv: null, childEnv: () => ({}) }
    const agent = s.customAgents?.find((c) => c.id === kind)
    return agent?.centralSpawn === true ? customEntry(agent, s, deps) : null
  }
  return {
    resolve,
    kinds() {
      const builtin = (Object.keys(AGENT_CONFIG) as BuiltinAgentId[]).map((id) => ({ id, label: AGENT_CONFIG[id].label, builtin: true, headless: false }))
      const custom = (settings().customAgents ?? []).flatMap((a) => {
        const entry = a.centralSpawn === true ? resolve(a.id) : null
        return entry ? [{ id: a.id, label: clean(a.label), builtin: false, headless: entry.headlessArgv !== null }] : []
      })
      return [...builtin, ...custom]
    },
  }
}
