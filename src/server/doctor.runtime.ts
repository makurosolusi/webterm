// Production wiring of the Doctor (doctor.ts): real PATH, CLI preflights, generated files, Telegram
// getMe, env settings for the sandbox switch, data-dir modes and the events hash chain.
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SANDBOX_ENV, agentSandboxOn, claudeSandboxSupported } from './agentSandbox'
import { binaryOnPath } from './binaryOnPath'
import { skipHomeInstalls } from './cli/cli.launcher'
import { installLinkCapture } from './linkCapture/linkCapture.shims'
import { BROWSER_SKILL_NAME, browserShimPath, buildBrowserShim, buildBrowserSkillBody, installBrowserAgentShim } from './browserAgentShim'
import { probeClaudeLaunch } from './claudeLauncher/claudeLaunch.probe'
import { claudeChildEnv } from './central/runtime/claudeOptions'
import { toClaudeReady } from './central/runtime/claudePreflight'
import { callBotApi, PollApiError } from './channels/telegramPollApi'
import { resolveTelegramBotToken, type TelegramSenderFetch } from './channels/telegramSend'
import { dataDir } from './config'
import { lastProviderTest } from './claudeProvider/claudeProvider.api'
import { providerView } from './claudeProvider/claudeProvider.store'
import { claudeStartup } from './claudeProvider/claudeProvider.startup'
import { SKILL_NAME, buildContextLinkSkillBody, buildContextShim, contextShimPath, installContextLink } from './contextLinkSkill'
import type { DoctorDeps, GeneratedFile } from './doctor'
import { activeEventsRuntime } from './events/eventsRuntime'
import type { EnvSettings } from './envSettings.service'
import { isEnabled } from './featureCapabilities.runtime'
import { writeHouseRules } from './hooksSettings'
import { houseRulesPath } from './hooksPaths'
import { HOUSE_RULES } from './webtermAwareness'
import { lastCentralMcpStatus, probeMcpServer } from './mcp/mcp.health'

const GETME_TIMEOUT_MS = 5_000
const PRIVATE_DIR_MODE = 0o700
/** Folders under the data dir that hold tokens or secrets. */
const PRIVATE_SUBDIRS = ['', 'secrets', 'node-settings']

export interface DoctorRuntimeInput {
  service: EnvSettings
  env: NodeJS.ProcessEnv
  /** Lock reason of the sandbox row in the Control model (shell env wins), if any. */
  sandboxLock?: string
  fetch?: TelegramSenderFetch
}

function generated(env: NodeJS.ProcessEnv): GeneratedFile[] {
  const skills = join(homedir(), '.claude', 'skills')
  const ctx = contextShimPath()
  const files: GeneratedFile[] = [
    { label: 'context-link shim', path: ctx, expected: buildContextShim() },
    { label: 'context-link skill', path: join(skills, SKILL_NAME, 'SKILL.md'), expected: buildContextLinkSkillBody(ctx) },
    { label: 'house rules', path: houseRulesPath(), expected: `${HOUSE_RULES}\n` },
  ]
  // The browser shim is installed when the browser capability is on (index.ts `ensureAgentShim`).
  if (isEnabled('browser', env)) {
    const shim = browserShimPath()
    files.push(
      { label: 'browser shim', path: shim, expected: buildBrowserShim() },
      { label: 'browser skill', path: join(skills, BROWSER_SKILL_NAME, 'SKILL.md'), expected: buildBrowserSkillBody(shim) },
    )
  }
  // Skills are not ours to check when this instance does not install them (dev:fresh shares the real HOME).
  return skipHomeInstalls(env) ? files.filter((f) => !f.path.startsWith(skills)) : files
}

const privateDirs = (): string[] => PRIVATE_SUBDIRS.map((s) => join(dataDir(), s)).filter((p) => existsSync(p))
const ownLoose = (p: string): boolean => {
  const st = statSync(p)
  return st.uid === process.getuid?.() && (st.mode & 0o077) !== 0
}

/** Real Doctor dependencies for the running server. */
export function doctorDeps(i: DoctorRuntimeInput): DoctorDeps {
  const env = i.env
  return {
    onPath: (bin) => binaryOnPath(bin, env['PATH'] ?? ''),
    // The same launch + provider Test connection checks (claudeStartup), probed stage by stage with Central's scrubbed env.
    claudeReady: async () => {
      const { launch, provider, method } = claudeStartup()
      const named = { method, ...(launch.wrapper.length > 0 ? { profile: launch.profile.name } : {}) }
      const r = toClaudeReady(await probeClaudeLaunch(launch, { env: claudeChildEnv(env), provider }))
      if (r.ok) return { ok: true, ...named }
      return { ok: false, reason: r.hint || r.code, missing: r.failed === 'wrapper_not_found' || r.failed === 'claude_not_found', ...named }
    },
    claudeProvider: () => ({ view: providerView(), lastTest: lastProviderTest() }),
    mcpServer: () => probeMcpServer(),
    lastCentralMcp: lastCentralMcpStatus,
    generated: () => generated(env),
    readFile: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }, // absent = stale, reported by the check
    installGenerated: () => {
      installContextLink()
      installLinkCapture()
      writeHouseRules()
      if (isEnabled('browser', env)) installBrowserAgentShim()
    },
    telegram: async () => {
      const token = resolveTelegramBotToken(env)
      if (token === undefined) return { state: 'unset' }
      try {
        const me = await callBotApi({
          method: 'getMe', params: {}, token, fetch: i.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch),
          signal: new AbortController().signal, timeoutMs: GETME_TIMEOUT_MS,
        })
        const u = (me as { username?: unknown } | null)?.username
        return { state: 'ok', ...(typeof u === 'string' && u !== '' ? { name: `@${u}` } : {}) }
      } catch (err) {
        return { state: err instanceof PollApiError && err.kind === 'fatal' ? 'rejected' : 'unreachable' }
      }
    },
    sandbox: () => ({ on: agentSandboxOn(env), supported: claudeSandboxSupported(), ...(i.sandboxLock ? { lockReason: i.sandboxLock } : {}) }),
    setSandbox: (on) => {
      const r = i.service.update({ set: { [AGENT_SANDBOX_ENV]: on ? 'on' : 'off' }, unset: [] })
      if (!r.ok) throw new Error(`doctor: cannot switch ${AGENT_SANDBOX_ENV} (${r.error})`)
    },
    looseDirs: () => privateDirs().filter(ownLoose),
    tightenDirs: () => { for (const p of privateDirs().filter(ownLoose)) chmodSync(p, PRIVATE_DIR_MODE) },
    verifyLedger: () => activeEventsRuntime()?.log.verifyChain() ?? null,
  }
}
