// Registry env: orchestrator, memory, control. Data murni (lihat envRegistry.types.ts).
import { flag, text, type EnvSpec } from './envRegistry.types'

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
]
