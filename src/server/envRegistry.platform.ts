// Registry env: orchestrator, memory, control, log (owner platform/logs). Data murni (lihat envRegistry.types.ts).
import { LOG_LEVELS } from '../shared/logEntry'
import { BROWSER_ENV_SPECS } from './browser/browser.envRegistry'
import { enumOf, flag, num, text, type EnvSpec } from './envRegistry.types'
import { DEFAULT_LOG_BUFFER, MAX_LOG_BUFFER, MIN_LOG_BUFFER } from './logs/logBus'
import { DEFAULT_LOG_LEVEL } from './logs/logger'

const ORCH = { owner: 'platform', section: 'Orkestrator' } as const
const MEM = { owner: 'platform', section: 'Memori' } as const
const CTRL = { owner: 'platform', section: 'Kontrol' } as const
// TRUST_PROXY hanya memengaruhi throttle webhook Telegram, jadi tampil di tab Channels.
const TGC = { owner: 'channels', section: 'Telegram' } as const
// Logging dibaca sekali saat boot (configureLogging), jadi restart wajib.
const LOGS = { owner: 'logs', section: 'Log', audience: 'advanced', restart: 'boot' } as const

export const PLATFORM_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_ORCHESTRATOR_RUN', 'orchestrator', {
    // Dibaca per panggilan lewat isEnabled('workers') (orchestratorRunModel), jadi hot; ledger selalu hidup (tanpa requires).
    ...ORCH, audience: 'user', hot: true, dangerous: true,
    label: 'Run orkestrator', description: 'Menjalankan worker nyata lewat /api/orchestrator/run.',
    dangerNote: 'Mengizinkan menjalankan worker nyata (shell dan edit file) di mesin server.',
  }),
  flag('WEBTERM_RUN_REQUIRE_APPROVAL', 'orchestrator', {
    ...ORCH, audience: 'user', hot: true, requires: [{ key: 'WEBTERM_ORCHESTRATOR_RUN' }],
    label: 'Run wajib approval', description: 'Setiap run butuh approval ledger (bawaan aktif); dibaca ulang tiap panggilan run.',
  }, 'on'),
  flag('WEBTERM_MEMORY_FILES', 'memory', { ...MEM, audience: 'user', hot: true, label: 'Berkas memori', description: 'Gerbang export dan rebuild file memory.' }),
  text('WEBTERM_MEMORY_DIR', 'memory', {
    ...MEM, audience: 'advanced', hot: true, dangerous: true, allowEmpty: true, unsetLabel: '<dataDir>/memory',
    requires: [{ key: 'WEBTERM_MEMORY_FILES' }],
    label: 'Direktori memory', description: 'Path absolut root file memory; kosong = <dataDir>/memory.',
    dangerNote: 'File memory ditulis dan dibaca dari path ini; arahkan hanya ke direktori yang memang milikmu.',
  }, { absolutePath: true }),
  text('WEBTERM_CONTROL_CWD_ROOTS', 'control', {
    ...CTRL, audience: 'advanced', hot: true, dangerous: true, allowEmpty: true,
    label: 'Root cwd control', description: 'Root tambahan untuk cwd spawn control, dipisah titik dua (Windows: titik koma).',
    dangerNote: 'Memperluas direktori yang boleh dipakai sebagai cwd shell yang di-spawn oleh control.',
  }),
  // Read when a Claude node's settings are written (agentSandbox.ts), so it applies to the next launch.
  flag('WEBTERM_AGENT_SANDBOX', 'control', {
    ...CTRL, audience: 'user', hot: true,
    label: 'Agent sandbox', description: 'Run Claude agent shell commands in the Claude Code sandbox (macOS) so they cannot read webterm secrets or other nodes\' tokens. Applies on next launch.',
    optionLabels: { on: 'On', off: 'Off' },
  }, 'on'),
  flag('WEBTERM_TRUST_PROXY', 'telegram', {
    ...TGC, audience: 'advanced', hot: true, dangerous: true,
    requires: [{ key: 'WEBTERM_TELEGRAM_MODE', oneOf: ['webhook', ''], note: 'Hanya relevan untuk throttle webhook.' }],
    label: 'Percaya proxy', description: 'Throttle webhook Telegram memakai x-forwarded-for. Aktifkan hanya di belakang proxy tepercaya.',
    dangerNote: 'Header x-forwarded-for dipercaya; tanpa proxy tepercaya penyerang bisa memalsukan IP dan menghindari throttle.',
  }),
  enumOf('WEBTERM_LOG_LEVEL', 'logs', LOG_LEVELS, DEFAULT_LOG_LEVEL, {
    ...LOGS, label: 'Level log', description: 'Level awal saat boot; panel Output bisa menimpanya sementara tanpa restart.',
  }),
  num('WEBTERM_LOG_BUFFER', 'logs', MIN_LOG_BUFFER, MAX_LOG_BUFFER, DEFAULT_LOG_BUFFER, {
    ...LOGS, unit: 'entri', label: 'Buffer log', description: 'Jumlah entri log yang disimpan di memori (ring buffer) untuk panel Output.',
  }),
  flag('WEBTERM_LOG_FILE', 'logs', {
    ...LOGS, label: 'File log', description: 'Tulis log harian ke <dataDir>/logs/webterm-YYYY-MM-DD.log (rotasi, maks 7 file).',
    optionLabels: { on: 'Aktif', off: 'Mati' },
  }, 'on'),
  ...BROWSER_ENV_SPECS,
]
