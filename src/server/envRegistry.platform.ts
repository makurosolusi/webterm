// Registry env: orchestrator, memory, control. Data murni (lihat envRegistry.types.ts).
import { LOG_LEVELS } from '../shared/logEntry'
import { BROWSER_ENV_SPECS } from './browser/browser.envRegistry'
import { enumOf, flag, num, text, type EnvSpec } from './envRegistry.types'
import { DEFAULT_LOG_BUFFER, MAX_LOG_BUFFER, MIN_LOG_BUFFER } from './logs/logBus'
import { DEFAULT_LOG_LEVEL } from './logs/logger'

export const PLATFORM_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_ORCHESTRATOR_RUN', 'orchestrator', {
    label: 'Orchestrator run',
    description: 'Menjalankan worker nyata lewat /api/orchestrator/run.',
    dangerous: true,
  }),
  flag('WEBTERM_RUN_REQUIRE_APPROVAL', 'orchestrator', { label: 'Run wajib approval', description: 'Setiap run butuh approval ledger.' }),
  flag('WEBTERM_MEMORY_FILES', 'memory', { label: 'Memory files', description: 'Gerbang export/rebuild file memory.', hot: true }),
  text('WEBTERM_MEMORY_DIR', 'memory', {
    label: 'Direktori memory',
    description: 'Path absolut root file memory; kosong = <dataDir>/memory.',
    hot: true,
    dangerous: true,
  }, { absolutePath: true }),
  text('WEBTERM_CONTROL_CWD_ROOTS', 'control', {
    label: 'Root cwd control',
    description: 'Root tambahan untuk cwd spawn control, dipisah delimiter path.',
    hot: true,
    dangerous: true,
  }),
  flag('WEBTERM_TRUST_PROXY', 'control', {
    label: 'Percaya proxy',
    description: 'Throttle webhook memakai x-forwarded-for. Aktifkan hanya di belakang proxy tepercaya.',
    dangerous: true,
  }),
  // Logging: dibaca sekali saat boot (configureLogging), jadi perlu restart.
  enumOf('WEBTERM_LOG_LEVEL', 'control', LOG_LEVELS, DEFAULT_LOG_LEVEL, {
    label: 'Level log',
    description: 'Level minimum yang dicatat di panel Output; dapat diubah sementara dari panel tanpa restart.',
  }),
  num('WEBTERM_LOG_BUFFER', 'control', MIN_LOG_BUFFER, MAX_LOG_BUFFER, DEFAULT_LOG_BUFFER, {
    label: 'Buffer log',
    description: 'Jumlah entri log yang disimpan di memori (ring buffer) untuk panel Output.',
  }),
  flag('WEBTERM_LOG_FILE', 'control', {
    label: 'File log',
    description: 'Tulis log harian ke <dataDir>/logs/webterm-YYYY-MM-DD.log (rotasi, maks 7 file).',
  }, 'on'),
  ...BROWSER_ENV_SPECS,
]
