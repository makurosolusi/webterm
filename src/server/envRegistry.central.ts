// Registry env: central (chat/runtime/otonomi), owner central. Data murni (lihat envRegistry.types.ts).
// `hot` hanya untuk kunci yang terbukti dibaca ulang tiap panggilan (centralModel.ts, turnService.ts, claudeRuntime.ts).
import { DEFAULT_RUNTIME_KIND } from './central/runtime/runtimeFlag'
import { enumOf, flag, text, type EnvSpec } from './envRegistry.types'

const C = { owner: 'central', section: 'Central' } as const
const CENTRAL_ON = { key: 'WEBTERM_CENTRAL' }
const RUNTIME_MODEL = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['claude', ''], note: 'Used by the Claude Code runtime.' }

export const CENTRAL_ENV_SPECS: readonly EnvSpec[] = [
  flag('WEBTERM_CENTRAL', 'central', { ...C, audience: 'user', hot: true, label: 'Central Agent', description: 'Turns the Central Agent on: an assistant that knows all your projects and nodes.' }, 'on'),
  enumOf('WEBTERM_CENTRAL_RUNTIME', 'central', ['claude', 'mock', 'off'], DEFAULT_RUNTIME_KIND, {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central agent engine',
    description: 'What answers for Central. Empty = automatic: Claude Code when it is set up, otherwise off. Unknown value = off.',
    // `mock` stays a valid value (tests, demo); the Control read model drops it from the offered options.
    optionLabels: { claude: 'Claude Code', mock: 'Demo (canned replies)', off: 'Off' },
  }),
  text('WEBTERM_CENTRAL_MODEL', 'central', {
    ...C, audience: 'advanced', hot: true, requires: [RUNTIME_MODEL], unsetLabel: 'Runtime default',
    label: 'Model override', description: 'Use this model for Central instead of the automatic choice. Empty = automatic. Applies from the next reply.',
  }),
  flag('WEBTERM_CENTRAL_MEMORY', 'central', {
    ...C, audience: 'user', hot: true, requires: [CENTRAL_ON],
    label: 'Central memory', description: 'Central remembers useful facts between conversations. Follows the Central Agent switch.',
  }, 'on'),
  flag('WEBTERM_CENTRAL_AUTONOMY', 'central', {
    ...C, audience: 'user', hot: true, dangerous: true,
    requires: [CENTRAL_ON, { key: 'WEBTERM_ORCHESTRATOR_RUN', note: 'Autonomy needs Orchestrator run.' }],
    label: 'Central autonomy', description: 'Central keeps working on its own, starting real workers without waiting to be asked.',
    dangerNote: 'Runs real workers (shell, file edits, commits) automatically every interval.',
  }),
]
