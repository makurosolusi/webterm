// Registry env: central (chat/runtime/otonomi). Data murni (lihat envRegistry.types.ts).
// `hot` hanya untuk kunci yang terbukti dibaca ulang tiap panggilan (centralModel.ts, turnService.ts).
import { DEFAULT_OPENCODE_BIN, DEFAULT_OPENCODE_MODEL } from './central/runtime/opencodeOptions'
import { enumOf, flag, text, type EnvSpec } from './envRegistry.types'

export const CENTRAL_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_CENTRAL', 'central', { label: 'Central', description: 'Proyeksi portfolio + pause/resume di /api/central.', hot: true }),
  flag('WEBTERM_CENTRAL_CHAT', 'central', { label: 'Central chat', description: 'Panel chat central (butuh Central aktif).' }),
  flag('WEBTERM_CENTRAL_TELEGRAM', 'central', { label: 'Central via Telegram', description: 'Jembatan chat central ke Telegram.' }),
  enumOf('WEBTERM_CENTRAL_RUNTIME', 'central', ['off', 'mock', 'opencode'], 'off', {
    label: 'Runtime central',
    description: 'mock hanya untuk demo; opencode menjalankan CLI opencode.',
  }),
  text('WEBTERM_CENTRAL_MODEL', 'central', { label: 'Model central', description: 'Model untuk runtime opencode.' }, { def: DEFAULT_OPENCODE_MODEL }),
  flag('WEBTERM_CENTRAL_PLANNER', 'central', { label: 'Central planner', description: 'Gerbang proposal planner (butuh tools=write).', hot: true }),
  enumOf('WEBTERM_CENTRAL_TOOLS', 'central', ['read', 'write'], 'read', { label: 'Tools central', description: 'Izin tool central.', hot: true }),
  flag('WEBTERM_CENTRAL_MEMORY', 'central', { label: 'Memori central', description: 'Sertakan memori dalam konteks chat central.', hot: true }),
  flag('WEBTERM_CENTRAL_AUTONOMY', 'central', {
    label: 'Otonomi central',
    description: 'Loop yang MENJALANKAN WORKER NYATA tiap interval.',
    dangerous: true,
  }),
  text('WEBTERM_OPENCODE_BIN', 'central', { label: 'Biner opencode', description: 'Executable yang dijalankan runtime opencode.', dangerous: true }, { def: DEFAULT_OPENCODE_BIN }),
  flag('WEBTERM_OPENCODE_ALLOW_TOOLS', 'central', {
    label: 'Izinkan tool mutasi opencode',
    description: 'Melepas deny pada tool bash/edit milik opencode.',
    dangerous: true,
  }),
]
