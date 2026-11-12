// The Settings sections (nav entry + page header) in one React-free module, so both the lazily loaded
// panel (SettingsPanel.tsx) and the URL whitelist (appRoute.ts, start-up chunk) read the same list.

/** Sidebar group headings, in display order. */
export const SETTINGS_GROUPS = ['General', 'Agents', 'System'] as const

/** Settings sections: nav entry + page header, one place, listed in group order. `icon` is a codicon name; `description` says what is inside. */
export const SETTINGS_SECTIONS = [
  { id: 'appearance', group: 'General', label: 'Appearance', icon: 'symbol-color', description: 'Theme, colors, font, canvas background' },
  { id: 'terminal', group: 'General', label: 'Terminal', icon: 'terminal', description: 'Copy, shortcuts, history, shell' },
  { id: 'canvas', group: 'General', label: 'Canvas', icon: 'layout', description: 'Grid, quick move, projects folder' },
  { id: 'notifications', group: 'General', label: 'Notifications', icon: 'bell', description: 'Desktop notifications and sound' },
  { id: 'claude', group: 'Agents', label: 'Claude', icon: 'hubot', description: 'Connection, permissions, profiles' },
  { id: 'central', group: 'Agents', label: 'Central', icon: 'comment-discussion', description: 'What it may do, check-ins, daily limit' },
  { id: 'rules', group: 'Agents', label: 'Rules & approvals', icon: 'shield', description: 'What agents may do without asking' },
  { id: 'memory', group: 'Agents', label: 'Memory', icon: 'book', description: 'What agents remember and share' },
  { id: 'automations', group: 'Agents', label: 'Automations', icon: 'clock', description: 'Routines that run agents for you' },
  { id: 'spending', group: 'Agents', label: 'Spending', icon: 'credit-card', description: 'Spending and limits that pause work' },
  { id: 'account', group: 'System', label: 'Account', icon: 'account', description: 'Username, password, signed-in devices' },
  { id: 'capabilities', group: 'System', label: 'Features', icon: 'extensions', description: 'Browser, files, Telegram' },
  { id: 'health', group: 'System', label: 'Health', icon: 'pulse', description: 'Is everything working on this machine' },
  // Hidden from the nav unless developer mode is on (./developerMode); links and `?settings=developer` still open it.
  { id: 'developer', group: 'System', label: 'Developer', icon: 'tools', description: 'Every raw value, for troubleshooting' },
] as const satisfies ReadonlyArray<{ id: string; group: (typeof SETTINGS_GROUPS)[number]; label: string; icon: string; description: string }>

export type SectionId = (typeof SETTINGS_SECTIONS)[number]['id']
