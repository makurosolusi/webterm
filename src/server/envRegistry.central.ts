// Registry env: central (chat/runtime/otonomi), owner central. Data murni (lihat envRegistry.types.ts).
// `hot` hanya untuk kunci yang terbukti dibaca ulang tiap panggilan (centralModel.ts, turnService.ts, opencodeOptions.ts).
import { DEFAULT_OPENCODE_BIN } from './central/runtime/opencodeOptions'
import { DEFAULT_RUNTIME_KIND } from './central/runtime/runtimeFlag'
import { enumOf, flag, text, type EnvSpec } from './envRegistry.types'

const C = { owner: 'central', section: 'Central' } as const
const CENTRAL_ON = { key: 'WEBTERM_CENTRAL' }
const RUNTIME_OPENCODE = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['opencode'], note: 'Hanya dipakai runtime opencode.' }
const RUNTIME_MODEL = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['opencode', 'claude'], note: 'Dipakai runtime opencode dan Claude Code.' }

export const CENTRAL_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_CENTRAL', 'central', { ...C, audience: 'user', hot: true, label: 'Central', description: 'Proyeksi portfolio dan pause/resume di /api/central.' }),
  flag('WEBTERM_CENTRAL_CHAT', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central chat', description: 'Panel chat central; juga gerbang jembatan Telegram (butuh Central aktif).',
  }),
  enumOf('WEBTERM_CENTRAL_RUNTIME', 'central', ['claude', 'opencode', 'mock', 'off'], DEFAULT_RUNTIME_KIND, {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Mesin agen central',
    description: 'Mesin balasan chat central. Nilai tak dikenal = nonaktif. Jembatan Telegram memakai pilihan baru setelah restart.',
    optionLabels: { claude: 'Claude Code', opencode: 'OpenCode (model gratis/pihak ketiga)', mock: 'Demo (jawaban tiruan)', off: 'Nonaktif' },
  }),
  text('WEBTERM_CENTRAL_MODEL', 'central', {
    ...C, audience: 'advanced', hot: true, requires: [RUNTIME_MODEL], unsetLabel: 'Bawaan runtime',
    label: 'Model (OpenCode / Claude)', description: 'Kosong = bawaan runtime. Format provider/model hanya untuk OpenCode; dibaca ulang tiap turn.',
  }),
  flag('WEBTERM_CENTRAL_PLANNER', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON, { key: 'WEBTERM_CENTRAL_TOOLS', oneOf: ['write'], note: 'Planner butuh tools boleh menulis.' }],
    label: 'Central planner', description: 'Gerbang proposal planner (butuh Central aktif dan tools boleh menulis).',
  }),
  enumOf('WEBTERM_CENTRAL_TOOLS', 'central', ['read', 'write'], 'read', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Tools central', description: 'Izin tool central: hanya membaca, atau boleh menulis (mengubah project dan task).',
    optionLabels: { read: 'Baca saja', write: 'Boleh menulis' },
  }),
  flag('WEBTERM_CENTRAL_MEMORY', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Memori central', description: 'Sertakan memori dalam konteks chat central.',
  }),
  flag('WEBTERM_CENTRAL_AUTONOMY', 'central', {
    ...C, audience: 'user', restart: 'boot', dangerous: true,
    requires: [CENTRAL_ON, { key: 'WEBTERM_ORCHESTRATOR_RUN', note: 'Otonomi butuh Orchestrator run.' }],
    label: 'Otonomi central', description: 'Loop yang menjalankan worker nyata tiap interval, tanpa menunggu perintah.',
    dangerNote: 'Menjalankan worker nyata (shell, edit file, commit) secara otomatis tiap interval.',
  }),
  text('WEBTERM_OPENCODE_BIN', 'central', {
    ...C, audience: 'advanced', hot: true, dangerous: true, requires: [RUNTIME_OPENCODE],
    label: 'Biner opencode', description: 'Hanya bila mesin = OpenCode. Executable yang dijalankan runtime opencode.',
    dangerNote: 'Path ini dieksekusi sebagai proses di mesin server; isi hanya biner tepercaya.',
  }, { def: DEFAULT_OPENCODE_BIN }),
  flag('WEBTERM_OPENCODE_ALLOW_TOOLS', 'central', {
    ...C, audience: 'advanced', hot: true, dangerous: true, requires: [RUNTIME_OPENCODE],
    label: 'Izinkan tool mutasi opencode', description: 'Hanya bila mesin = OpenCode. Melepas penolakan tool mutasi pada proses opencode anak.',
    dangerNote: 'Melepas penolakan bash/edit/webfetch/task pada proses opencode anak, sehingga bisa mengubah mesin ini.',
  }),
]
