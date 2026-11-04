// All Control panel UI text (English product text, Rule 15).
export const CONTROL_TEXT = {
  tab: 'Control',
  intro: 'Every behaviour setting, what it is right now, where it comes from, and why. Read-only for now.',
  search: 'Filter settings',
  envOnly: 'Env-only (no UI switch)',
  modifiedOnly: 'Modified',
  loading: 'Loading effective configuration…',
  loadFailed: 'The effective configuration could not be loaded. Try again in a moment.',
  empty: 'No setting matches the filter.',
  mockBadge: 'MOCK',
  mockTitle: 'A runtime is using the simulated engine: replies are not produced by a real agent.',
  colKey: 'Setting',
  colValue: 'Effective',
  colSource: 'Source',
  colReason: 'Why',
  colUi: 'UI switch',
  noUi: 'Env-only',
  secretSet: 'set',
  secretUnset: 'unset',
  modifiedMark: 'Modified from the default',
  count: (shown: number, total: number): string => `${shown} of ${total} settings`,
  protectionTitle: 'Agent protection',
  protectionMissing: 'Agent protection status is not available yet.',
  protectionLevel: { protected: 'Protected', mitigation: 'Mitigation only' } as Readonly<Record<string, string>>,
} as const

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  default: 'Default',
  env: 'Shell env',
  '.env': '.env file',
  settings: 'Settings',
  capability: 'Capability card',
}
