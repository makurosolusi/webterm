// Registry env: central (chat/runtime/otonomi), owner central. Data murni (lihat envRegistry.types.ts).
// `hot` hanya untuk kunci yang terbukti dibaca ulang tiap panggilan (centralModel.ts, turnService.ts, claudeRuntime.ts).
import { DEFAULT_RUNTIME_KIND } from './central/runtime/runtimeFlag'
import { enumOf, flag, text, type EnvSpec } from './envRegistry.types'

const C = { owner: 'central', section: 'Central' } as const
const CENTRAL_ON = { key: 'WEBTERM_CENTRAL' }
const RUNTIME_MODEL = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['claude', ''], note: 'Used by the Claude Code runtime.' }

export const CENTRAL_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_CENTRAL', 'central', { ...C, audience: 'user', hot: true, label: 'Central', description: 'Portfolio projection and pause/resume at /api/central.' }),
  flag('WEBTERM_CENTRAL_CHAT', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central chat', description: 'Central chat panel; also gates the Telegram bridge (needs Central on).',
  }),
  enumOf('WEBTERM_CENTRAL_RUNTIME', 'central', ['claude', 'mock', 'off'], DEFAULT_RUNTIME_KIND, {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central agent engine',
    description: 'Central chat engine. Empty = automatic: Claude Code when it is set up, otherwise off (never Demo). Unknown value = off.',
    optionLabels: { claude: 'Claude Code', mock: 'Demo (canned replies)', off: 'Off' },
  }),
  text('WEBTERM_CENTRAL_MODEL', 'central', {
    ...C, audience: 'advanced', hot: true, requires: [RUNTIME_MODEL], unsetLabel: 'Runtime default',
    label: 'Model (Claude)', description: 'Empty = runtime default; re-read every turn.',
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
]
