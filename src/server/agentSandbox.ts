// Same-uid hardening for agent sessions (plan F0-a). Every agent runs as the same OS user as the
// server, so file mode 0600 protects nothing from it. What does protect:
//  - Claude Code's OS sandbox (macOS Seatbelt): blocks EVERY process a Bash call starts — cat, python,
//    sh -c, globs — from reading the data dir. Verified on Claude Code 2.1.318 / macOS 15.5.
//  - Claude Code `permissions.deny`: covers its own file tools (Read/Edit/Write/Grep) plus the file
//    commands it recognises in Bash (cat/head/tail/sed). A python/node script bypasses it, so on its
//    own it is a mitigation, not a boundary.
// Other CLIs (codex, gemini, opencode, ...) get no webterm-managed sandbox: they are labelled
// "mitigation" so the UI never overstates what holds.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from '../shared/workspace'
import { flagOr } from './envFlag'

/** Settings knob (on|off, default on): write the Claude Code sandbox block into node settings. */
export const AGENT_SANDBOX_ENV = 'WEBTERM_AGENT_SANDBOX'

/** Read at settings-write time, so a change applies to the next agent launched. */
export function agentSandboxOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOr(env[AGENT_SANDBOX_ENV], true)
}

/**
 * Data-dir entries an agent shell must still READ: the skill shims it runs (`context-links`,
 * `browser-agent`) and orchestrator worktrees, which can be an agent's cwd. None of them holds a
 * credential. The node's OWN header file is added per node (`ownHeaders`).
 */
export const AGENT_READABLE_ENTRIES = ['context-links', 'browser-agent', 'worktrees'] as const

/**
 * Data-dir entries holding credentials or state an agent must never read or write directly: the
 * root token and provider secrets (`secrets`), every node's hook header file (`node-settings`),
 * the SQLite stores (workspaces, ledger: approvals, memory, audit), channel/bot state, browser
 * profiles + cookie vault, Central's private home, and legacy nodeterm credential files.
 * `*` is a gitignore glob in permission rules; the sandbox gets the whole data dir instead.
 */
export const AGENT_SECRET_ENTRIES = [
  'secrets', 'node-settings', 'node-tokens', 'codex-bin', 'channels', 'browser', 'central', 'relay', 'sock', 'memory', 'logs',
  'webterm.db*', 'ledger.db*', 'auth.json', 'node-auth-key.bin', 'settings.json', 'sessions.json',
  'agent-status.json', 'integration-receipts.json',
] as const

/** The shims agents execute: readable, but replacing one would run code inside every other agent. */
const AGENT_EXEC_ENTRIES = ['context-links', 'browser-agent'] as const

/**
 * Dotenv files that hold real values. Listed, not `.env*`: a deny rule always beats an allow, and
 * `.env.example` / `.env.sample` / `.env.template` must stay readable for everyday work.
 * ponytail: a fixed list misses exotic names (`.env.qa`); a PreToolUse hook could match by "not a template".
 */
export const SECRET_DOTENV_FILES = [
  '.env', '.env.local', '.env.*.local', '.env.development', '.env.dev', '.env.production', '.env.prod',
  '.env.staging', '.env.test', '.envrc',
] as const

/**
 * Dev tools that need the keychain, a daemon socket or ssh-agent, which Seatbelt blocks: they run
 * outside the sandbox (docs: `sandbox.excludedCommands`, Bash-rule syntax, `x *` = with or without
 * args; every command of a compound call must match). Git network verbs are here for credential
 * helpers (osxkeychain) and ssh remotes.
 */
export const SANDBOX_EXCLUDED_COMMANDS = [
  'gh *', 'docker *', 'brew *', 'op *', 'security *', 'ssh *',
  'git push *', 'git pull *', 'git fetch *', 'git clone *',
] as const

/** Ask (even in bypassPermissions) before Claude reruns a sandbox-blocked command unsandboxed. */
export const UNSANDBOXED_RETRY_RULE = 'Bash(dangerouslyDisableSandbox:true)'

/** Real path: Seatbelt matches resolved paths (macOS `/var` → `/private/var`). Falls back to the input. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path // not created yet: nothing to resolve, the literal is the best we have
  }
}

/** Is the Claude Code sandbox usable for webterm sessions on this platform? Only macOS: on Linux the
 *  sandbox gives each command a private localhost, so the skill shims could not reach the server. */
export function claudeSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}

export interface ProtectionOpts {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** This node's own header file: the one credential its shims may read. */
  ownHeaders?: string
}

/**
 * The `permissions` + `sandbox` part of a webterm-generated Claude `--settings` file.
 * `permissions.deny` paths use `//abs` (absolute, gitignore syntax); sandbox paths are plain.
 */
export function claudeProtectionSettings(dataDirPath: string, opts: ProtectionOpts = {}): Record<string, unknown> {
  const { platform = process.platform, env = process.env, ownHeaders } = opts
  const dir = real(dataDirPath)
  const abs = (entry: string) => `/${join(dir, entry)}` // `//Users/...`: absolute in permission rules
  const deny = [
    ...AGENT_SECRET_ENTRIES.flatMap((e) => [`Read(${abs(e)})`, `Read(${abs(e)}/**)`]),
    ...AGENT_EXEC_ENTRIES.map((e) => `Edit(${abs(e)}/**)`),
    `Bash(cat ${dir}/*)`,
    ...SECRET_DOTENV_FILES.map((f) => `Read(**/${f})`),
  ]
  const permissions = { deny, ask: [UNSANDBOXED_RETRY_RULE] }
  if (!claudeSandboxSupported(platform) || !agentSandboxOn(env)) return { permissions }
  // Write deny lists entries one by one: a deny on the whole dir would beat the worktree allow
  // (verified), and worktrees must stay writable as an agent cwd.
  const writeDenied = [...AGENT_SECRET_ENTRIES, ...AGENT_EXEC_ENTRIES].flatMap((e) =>
    e.endsWith('*') ? [join(dir, e.slice(0, -1)), ...['-wal', '-shm', '-journal'].map((s) => join(dir, e.slice(0, -1) + s))] : [join(dir, e)]
  )
  return {
    permissions,
    sandbox: {
      enabled: true,
      filesystem: {
        // Home stays writable (caches, other repos, ~/.config): the sandbox is here to wall off
        // the data dir, not to change what a developer's agent can do elsewhere.
        allowWrite: ['~/'],
        denyRead: [dir],
        // Narrower path wins for reads (docs + verified): another node's header file stays denied.
        allowRead: [...AGENT_READABLE_ENTRIES.map((e) => join(dir, e)), ...(ownHeaders ? [real(ownHeaders)] : [])],
        denyWrite: writeDenied,
      },
      // `*` + local binding: network behaves as before (registries, git, the webterm API on
      // 127.0.0.1) — verified to need no prompt in manual mode.
      network: { allowedDomains: ['*'], allowLocalBinding: true },
      excludedCommands: [...SANDBOX_EXCLUDED_COMMANDS],
    },
  }
}

export type ProtectionLevel = 'protected' | 'mitigation'
export interface AgentProtection {
  kind: BuiltinAgentId
  level: ProtectionLevel
  reasons: string[]
}

const NO_ROOT = 'The root access token is never passed to the session.'
const OWN_TOKEN = 'Its node token lives in a file only this node may read, never in the process environment.'

/** What actually holds for each agent kind, in plain English for the Control panel. */
export function agentProtection(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): AgentProtection[] {
  return BUILTIN_AGENT_IDS.map((kind): AgentProtection => {
    if (kind === 'claude' && claudeSandboxSupported(platform) && agentSandboxOn(env)) {
      // 'mitigation', not 'protected' (sec-208-1): the sandbox walls off the data dir files, but the
      // webterm API stays reachable from inside it and the UI-only check on file/board routes
      // (routes/route.uiOnly.ts) rests on a forgeable fetch-metadata header.
      return {
        kind,
        level: 'mitigation',
        reasons: [
          'Claude Code sandbox blocks shell commands from reading the webterm data dir files and the tokens of other nodes directly.',
          'The webterm API on 127.0.0.1 stays reachable from the sandbox; file and board routes answer only the webterm page or the root token, a check a deliberate script can still forge.',
          'Permission rules block Claude file tools on webterm secrets and .env files (templates stay readable).',
          'Running a command outside the sandbox asks for your approval.',
          'gh, docker, brew, op, security, ssh and git push/pull/fetch/clone run outside the sandbox so keychain and sockets keep working.',
          OWN_TOKEN,
          NO_ROOT,
        ],
      }
    }
    if (kind === 'claude') {
      return {
        kind,
        level: 'mitigation',
        reasons: [
          claudeSandboxSupported(platform)
            ? `Agent sandbox is switched off (${AGENT_SANDBOX_ENV}=off).`
            : 'Claude Code sandbox is not enabled on this platform.',
          'Permission rules cover Claude file tools and cat/head/tail, but a script can still read the webterm data dir.',
          NO_ROOT,
        ],
      }
    }
    return {
      kind,
      level: 'mitigation',
      reasons: [
        'No sandbox is configured for this CLI: it can read the webterm data dir like any process of your user.',
        OWN_TOKEN,
        NO_ROOT,
      ],
    }
  })
}
