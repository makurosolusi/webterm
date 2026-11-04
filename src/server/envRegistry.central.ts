// Registry env: central (chat/runtime/otonomi), owner central. Data murni (lihat envRegistry.types.ts).
// `hot` hanya untuk kunci yang terbukti dibaca ulang tiap panggilan (centralModel.ts, turnService.ts, opencodeOptions.ts).
import { DEFAULT_OPENCODE_BIN } from './central/runtime/opencodeOptions'
import { DEFAULT_RUNTIME_KIND } from './central/runtime/runtimeFlag'
import { enumOf, flag, text, type EnvSpec } from './envRegistry.types'

const C = { owner: 'central', section: 'Central' } as const
const CENTRAL_ON = { key: 'WEBTERM_CENTRAL' }
const RUNTIME_OPENCODE = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['opencode'], note: 'Only used by the opencode runtime.' }
const RUNTIME_MODEL = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['opencode', 'claude'], note: 'Used by the opencode and Claude Code runtimes.' }

export const CENTRAL_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_CENTRAL', 'central', { ...C, audience: 'user', hot: true, label: 'Central', description: 'Portfolio projection and pause/resume at /api/central.' }),
  flag('WEBTERM_CENTRAL_CHAT', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central chat', description: 'Central chat panel; also gates the Telegram bridge (needs Central on).',
  }),
  enumOf('WEBTERM_CENTRAL_RUNTIME', 'central', ['claude', 'opencode', 'mock', 'off'], DEFAULT_RUNTIME_KIND, {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central agent engine',
    description: 'Central chat engine. Empty = automatic: Claude Code, then OpenCode, then off (never Demo). Unknown value = off.',
    optionLabels: { claude: 'Claude Code', opencode: 'OpenCode (free/third-party models)', mock: 'Demo (canned replies)', off: 'Off' },
  }),
  text('WEBTERM_CENTRAL_MODEL', 'central', {
    ...C, audience: 'advanced', hot: true, requires: [RUNTIME_MODEL], unsetLabel: 'Runtime default',
    label: 'Model (OpenCode / Claude)', description: 'Empty = runtime default. The provider/model format is only for OpenCode; re-read every turn.',
  }),
  flag('WEBTERM_CENTRAL_PLANNER', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON, { key: 'WEBTERM_CENTRAL_TOOLS', oneOf: ['write'], note: 'The planner needs write tools.' }],
    label: 'Central planner', description: 'Gates planner proposals (needs Central on and write tools).',
  }),
  enumOf('WEBTERM_CENTRAL_TOOLS', 'central', ['read', 'write'], 'read', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central tools', description: 'Central tool permission: read only, or allowed to write (change projects and tasks).',
    optionLabels: { read: 'Read only', write: 'Can write' },
  }),
  flag('WEBTERM_CENTRAL_MEMORY', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central memory', description: 'Include memory in the central chat context.',
  }),
  flag('WEBTERM_CENTRAL_AUTONOMY', 'central', {
    ...C, audience: 'user', hot: true, dangerous: true,
    requires: [CENTRAL_ON, { key: 'WEBTERM_ORCHESTRATOR_RUN', note: 'Autonomy needs Orchestrator run.' }],
    label: 'Central autonomy', description: 'A loop that runs real workers every interval without waiting for instructions.',
    dangerNote: 'Runs real workers (shell, file edits, commits) automatically every interval.',
  }),
  text('WEBTERM_OPENCODE_BIN', 'central', {
    ...C, audience: 'advanced', hot: true, dangerous: true, requires: [RUNTIME_OPENCODE],
    label: 'opencode binary', description: 'Only when the engine is OpenCode. The executable run by the opencode runtime.',
    dangerNote: 'This path is executed as a process on the server machine; only enter a trusted binary.',
  }, { def: DEFAULT_OPENCODE_BIN }),
  flag('WEBTERM_OPENCODE_ALLOW_TOOLS', 'central', {
    ...C, audience: 'advanced', hot: true, dangerous: true, requires: [RUNTIME_OPENCODE],
    label: 'Allow opencode mutating tools', description: 'Only when the engine is OpenCode. Lifts the denial of mutating tools in the child opencode process.',
    dangerNote: 'Lifts the denial of bash/edit/webfetch/task in the child opencode process, so it can change this machine.',
  }),
]
