// Doctor v1 (F1-f, user-flow §3 #7): health checks over what webterm needs from the machine, each
// with a status, an English explanation and, only where it is safe and idempotent, a one-click fix.
// Pure over `DoctorDeps` so every pass/fail path is testable with fakes; real wiring: doctor.runtime.ts.
// Never carries a secret: the Telegram check reports valid/invalid/unset, never the token.
import type { VerifyResult } from './events/eventModel'
import type { ProviderView } from './claudeProvider/claudeProvider.model'
import type { CentralMcpSeen, McpProbe } from './mcp/mcp.health'
import { MCP_USABLE } from './mcp/mcp.paths'

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'off'
export const DOCTOR_IDS = ['claude', 'tools', 'skills', 'telegram', 'ripgrep', 'tmux', 'sandbox', 'dataDir', 'ledger'] as const
export type DoctorId = (typeof DOCTOR_IDS)[number]

export interface DoctorCheck {
  id: DoctorId
  title: string
  status: DoctorStatus
  /** What was found and what it means, one or two English sentences. */
  detail: string
  /** Label of the safe one-click fix, when there is one. */
  fix?: string
  /** The Settings field where the user fixes it (a `data-field` id); the client links to it. */
  go?: { field: string }
}

/** A file webterm generates (shim, skill, house rules): `expected` is what the current build writes. */
export interface GeneratedFile { label: string; path: string; expected: string }
/** Claude readiness through the default launch profile: `via` names a wrapper (`envman (via profile X)`), `missing` = binary not found. */
export type ClaudeLaunchReady = { ok: true; via?: string } | { ok: false; reason: string; via?: string; missing?: boolean }
export type TelegramProbe = { state: 'unset' } | { state: 'ok'; name?: string } | { state: 'rejected' | 'unreachable' }

export interface DoctorDeps {
  onPath(bin: string): boolean
  /** Staged probe of the default Claude launch profile (wrapper/claude on PATH, then login). */
  claudeReady(): Promise<ClaudeLaunchReady>
  /** Saved Claude provider (never the secret) + the last Test connection of this process; absent = login. */
  claudeProvider?(): { view: ProviderView; lastTest: { ok: boolean; message: string } | null }
  /** Starts webterm's MCP tool server the way agents and Central do and waits for its `initialize` answer. */
  mcpServer(): Promise<McpProbe>
  /** Webterm MCP server status from the last Central turn's init; null = no turn since start. */
  lastCentralMcp(): CentralMcpSeen | null
  generated(): GeneratedFile[]
  readFile(path: string): string | null
  installGenerated(): void
  telegram(): Promise<TelegramProbe>
  sandbox(): { on: boolean; supported: boolean; lockReason?: string }
  setSandbox(on: boolean): void
  /** Data dirs whose mode lets group/other in (should be 0700). */
  looseDirs(): string[]
  tightenDirs(): void
  /** Full hash-chain verify; null = ledger off (shadow mode). */
  verifyLedger(): VerifyResult | null
}

const hostOf = (url: string | undefined): string => { try { return new URL(url ?? '').host } catch { return '(no URL)' } }

type Probe = (d: DoctorDeps) => Promise<DoctorCheck> | DoctorCheck
const check = (id: DoctorId, title: string, status: DoctorStatus, detail: string, fix?: string, go?: DoctorCheck['go']): DoctorCheck =>
  ({ id, title, status, detail, ...(fix ? { fix } : {}), ...(go ? { go } : {}) })
/** Settings fields the checks point at (client `settings.link` ids). */
const GO_PROVIDER = { field: 'claude-provider' }
const GO_TELEGRAM = { field: 'capability.telegram' }

const PROBES: Record<DoctorId, Probe> = {
  async claude(d) {
    const t = 'Claude Code CLI'
    const r = await d.claudeReady()
    const via = r.via ? ` Launch: ${r.via}.` : ''
    if (!r.ok && r.missing) return check('claude', t, 'warn', `${r.reason || 'The claude command is not on PATH.'} Claude agent nodes and the Claude engine cannot start until it is found.${via}`)
    // Active Claude provider: a key/endpoint replaces the login, so it is checked instead.
    const { view: v, lastTest } = d.claudeProvider?.() ?? { view: { mode: 'login', secretSet: false, ready: true }, lastTest: null }
    if (v.mode !== 'login') {
      const what = v.mode === 'apiKey' ? 'Anthropic API key' : `custom endpoint ${hostOf(v.baseUrl)}`
      if (!v.ready) return check('claude', t, 'fail', `Installed; provider ${what} is selected but no key is saved, so Claude cannot start. Add it in the Claude provider settings.`, undefined, GO_PROVIDER)
      if (!lastTest) return check('claude', t, 'warn', `Installed; provider ${what} is saved but not tested since the server started. Press Test connection in the Claude provider settings.`, undefined, GO_PROVIDER)
      return check('claude', t, lastTest.ok ? 'ok' : 'fail', `Installed; provider ${what}: ${lastTest.message}`)
    }
    return r.ok ? check('claude', t, 'ok', `Installed and logged in.${via}`)
      : check('claude', t, 'fail', `Installed but not ready (${r.reason}). Open a terminal node, run claude and log in.${via}`)
  },
  async tools(d) {
    const t = 'webterm tool server (MCP)'
    const p = await d.mcpServer()
    if (!p.ok) return check('tools', t, 'fail', `It did not start (${p.reason}). Central and Claude agent nodes have no webterm tools until it does.`)
    const seen = d.lastCentralMcp()
    if (seen && !MCP_USABLE.has(seen.status)) return check('tools', t, 'warn', `It starts (${p.server}), but Claude reported it as ${seen.status} in the last Central turn. Retry that turn; if it repeats, check the server log.`)
    return check('tools', t, 'ok', `Starts and answers (${p.server}): Central and Claude agent nodes get their webterm tools.`)
  },
  skills(d) {
    const stale = d.generated().filter((f) => d.readFile(f.path) !== f.expected).map((f) => f.label)
    return stale.length === 0
      ? check('skills', 'Agent skills and house rules', 'ok', 'Context-link and browser skills, their shims, and the house rules are present and current. Hook settings are rewritten at every agent launch.')
      : check('skills', 'Agent skills and house rules', 'fail', `Missing or out of date: ${stale.join(', ')}. Agents will not know these webterm features until they are rewritten.`, 'Reinstall')
  },
  async telegram(d) {
    const t = 'Telegram bot'
    const p = await d.telegram()
    if (p.state === 'unset') return check('telegram', t, 'off', 'No bot token. Connect a bot in the Telegram settings.', undefined, GO_TELEGRAM)
    if (p.state === 'ok') return check('telegram', t, 'ok', `Token accepted by Telegram${p.name ? ` (${p.name})` : ''}.`)
    return p.state === 'rejected'
      ? check('telegram', t, 'fail', 'Telegram rejected the bot token. Create a new token with BotFather and connect it again.')
      : check('telegram', t, 'warn', 'Telegram could not be reached to check the token. Check the network and try again.')
  },
  ripgrep: (d) => d.onPath('rg')
    ? check('ripgrep', 'ripgrep (rg)', 'ok', 'Available: Find in Files and Quick Open use it.')
    : check('ripgrep', 'ripgrep (rg)', 'warn', 'Not on PATH: Find in Files is unavailable and Quick Open falls back to a slower scan. Install ripgrep (for example brew install ripgrep).'),
  tmux: (d) => d.onPath('tmux')
    ? check('tmux', 'tmux', 'ok', 'Available: terminal sessions survive a server reload.')
    : check('tmux', 'tmux', 'warn', 'Not on PATH: terminal sessions end when the server restarts. Install tmux (for example brew install tmux).'),
  sandbox(d) {
    const s = d.sandbox()
    const t = 'Agent sandbox'
    if (!s.supported) return check('sandbox', t, 'off', 'The Claude Code sandbox is not supported on this platform; agent protection is a mitigation only.')
    if (s.on) return check('sandbox', t, 'ok', 'On: Claude agent shell commands cannot read webterm secrets or other nodes\' tokens. Applies to new agent launches.')
    return check('sandbox', t, 'warn', `Off: agent shell commands can read webterm secrets.${s.lockReason ? ` ${s.lockReason}` : ''}`, s.lockReason ? undefined : 'Turn on')
  },
  dataDir(d) {
    const loose = d.looseDirs()
    return loose.length === 0
      ? check('dataDir', 'Data folder permissions', 'ok', 'Only your user can read the data folder (0700).')
      : check('dataDir', 'Data folder permissions', 'fail', `Readable by other users: ${loose.join(', ')}. It holds tokens and secrets.`, 'Restrict to 0700')
  },
  ledger(d) {
    const v = d.verifyLedger()
    const t = 'Ledger hash chain'
    if (v === null) return check('ledger', t, 'off', 'The ledger is not running, so there is no chain to verify.')
    return v.ok ? check('ledger', t, 'ok', `Verified ${v.checked} events; the chain is intact.`)
      : check('ledger', t, 'fail', `Chain broken at event ${v.brokenAt.seq} (${v.brokenAt.reason.replace('_', ' ')}): a stored event was changed or removed. This cannot be fixed automatically; keep the file as evidence.`)
  },
}

/** Run every check; a probe that throws becomes a `fail` row instead of hiding the others. */
export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  return Promise.all(DOCTOR_IDS.map(async (id) => {
    try {
      return await PROBES[id](d)
    } catch (err) {
      return check(id, id, 'fail', `The check itself failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }))
}

const FIXES: Partial<Record<DoctorId, (d: DoctorDeps) => void>> = {
  skills: (d) => d.installGenerated(),
  sandbox: (d) => d.setSandbox(true),
  dataDir: (d) => d.tightenDirs(),
}

export const isDoctorId = (v: unknown): v is DoctorId => typeof v === 'string' && (DOCTOR_IDS as readonly string[]).includes(v)

/** Apply the fix of one check if it currently offers one, then return that check re-run. */
export async function fixDoctor(id: DoctorId, d: DoctorDeps): Promise<{ ok: true; check: DoctorCheck } | { ok: false; error: 'no_fix' }> {
  const before = await PROBES[id](d)
  const fix = FIXES[id]
  if (!before.fix || !fix) return { ok: false, error: 'no_fix' }
  fix(d)
  return { ok: true, check: await PROBES[id](d) }
}
