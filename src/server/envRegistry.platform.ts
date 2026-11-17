// Registry env: orchestrator, memory, control, log (owner platform/logs). Data murni (lihat envRegistry.types.ts).
import { LOG_LEVELS } from '../shared/logEntry'
import { BROWSER_ENV_SPECS } from './browser/browser.envRegistry'
import { enumOf, flag, num, text, type EnvSpec } from './envRegistry.types'
import { DEFAULT_LOG_BUFFER, MAX_LOG_BUFFER, MIN_LOG_BUFFER } from './logs/logBus'
import { DEFAULT_LOG_LEVEL } from './logs/logger'

const ORCH = { owner: 'platform', section: 'Orchestrator' } as const
const MEM = { owner: 'platform', section: 'Memory' } as const
const CTRL = { owner: 'platform', section: 'Control' } as const
// TRUST_PROXY hanya memengaruhi throttle webhook Telegram, jadi tampil di tab Channels.
const TGC = { owner: 'channels', section: 'Telegram' } as const
// Logging dibaca sekali saat boot (configureLogging), jadi restart wajib.
const LOGS = { owner: 'logs', section: 'Log', audience: 'advanced', restart: 'boot' } as const

export const PLATFORM_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_ORCHESTRATOR_RUN', 'orchestrator', {
    // Dibaca per panggilan lewat isEnabled('workers') (orchestratorRunModel), jadi hot; ledger selalu hidup (tanpa requires).
    ...ORCH, audience: 'user', hot: true, dangerous: true,
    label: 'Orchestrator run', description: 'Runs real workers through /api/orchestrator/run.',
    dangerNote: 'Allows running real workers (shell and file edits) on the server machine.',
  }, 'on'),
  flag('WEBTERM_RUN_REQUIRE_APPROVAL', 'orchestrator', {
    ...ORCH, audience: 'user', hot: true, requires: [{ key: 'WEBTERM_ORCHESTRATOR_RUN' }],
    label: 'Runs require approval', description: 'Every run needs a ledger approval (off by default, owner decision 2026-11-17); re-read on every run call.',
  }, 'off'),
  flag('WEBTERM_MEMORY_FILES', 'memory', { ...MEM, audience: 'user', hot: true, label: 'Memory files', description: 'Gate for exporting and rebuilding memory files.' }, 'on'),
  text('WEBTERM_MEMORY_DIR', 'memory', {
    ...MEM, audience: 'advanced', hot: true, dangerous: true, allowEmpty: true, unsetLabel: '<dataDir>/memory',
    requires: [{ key: 'WEBTERM_MEMORY_FILES' }],
    label: 'Memory directory', description: 'Absolute path of the memory files root; empty = <dataDir>/memory.',
    dangerNote: 'Memory files are written to and read from this path; point it only at a directory you own.',
  }, { absolutePath: true }),
  text('WEBTERM_CONTROL_CWD_ROOTS', 'control', {
    ...CTRL, audience: 'advanced', hot: true, dangerous: true, allowEmpty: true,
    label: 'Control cwd roots', description: 'Extra roots for control spawn cwd, separated by colons (Windows: semicolons).',
    dangerNote: 'Widens the directories that may be used as the cwd of shells spawned by control.',
  }),
  // Read when a Claude node's settings are written (agentSandbox.ts), so it applies to the next launch.
  flag('WEBTERM_AGENT_SANDBOX', 'control', {
    ...CTRL, audience: 'user', hot: true,
    label: 'Agent sandbox', description: 'Run Claude agent shell commands in the Claude Code sandbox (macOS) so they cannot read webterm secrets or other nodes\' tokens. Applies on next launch.',
    optionLabels: { on: 'On', off: 'Off' },
  }, 'on'),
  flag('WEBTERM_TRUST_PROXY', 'telegram', {
    ...TGC, audience: 'advanced', hot: true, dangerous: true,
    requires: [{ key: 'WEBTERM_TELEGRAM_MODE', oneOf: ['webhook', ''], note: 'Only relevant for webhook throttling.' }],
    label: 'Trust proxy', description: 'Telegram webhook throttling uses x-forwarded-for. Enable only behind a trusted proxy.',
    dangerNote: 'The x-forwarded-for header is trusted; without a trusted proxy an attacker can spoof IPs and evade throttling.',
  }),
  enumOf('WEBTERM_LOG_LEVEL', 'logs', LOG_LEVELS, DEFAULT_LOG_LEVEL, {
    ...LOGS, label: 'Log level', description: 'Initial level at boot; the Output panel can override it temporarily without a restart.',
  }),
  num('WEBTERM_LOG_BUFFER', 'logs', MIN_LOG_BUFFER, MAX_LOG_BUFFER, DEFAULT_LOG_BUFFER, {
    ...LOGS, unit: 'entries', label: 'Log buffer', description: 'Number of log entries kept in memory (ring buffer) for the Output panel.',
  }),
  flag('WEBTERM_LOG_FILE', 'logs', {
    ...LOGS, label: 'Log file', description: 'Write daily logs to <dataDir>/logs/webterm-YYYY-MM-DD.log (rotated, max 7 files).',
    optionLabels: { on: 'On', off: 'Off' },
  }, 'on'),
  ...BROWSER_ENV_SPECS,
]
