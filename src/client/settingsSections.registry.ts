// The Settings sections (nav entry + page header) in one React-free module, so both the lazily loaded
// panel (SettingsPanel.tsx) and the URL whitelist (appRoute.ts, start-up chunk) read the same list.

/** Sidebar group headings, in display order. */
export const SETTINGS_GROUPS = ['General', 'Agents', 'Account & system'] as const

/** Settings sections: nav entry + page header, one place, listed in group order. `icon` is an outline
 *  codicon name; `description` says what is inside (page header and search, not the one-line nav item). */
export const SETTINGS_SECTIONS = [
  { id: 'appearance', group: 'General', label: 'Appearance', icon: 'symbol-color', description: 'Theme and canvas background' },
  { id: 'terminal', group: 'General', label: 'Terminal', icon: 'terminal', description: 'Colors, font, cursor, history, shell' },
  { id: 'keyboard', group: 'General', label: 'Keyboard Shortcuts', icon: 'keyboard', description: 'See, change and reset every shortcut' },
  { id: 'canvas', group: 'General', label: 'Canvas', icon: 'layout', description: 'Grid, nodes, cables, projects folder' },
  { id: 'notifications', group: 'General', label: 'Notifications', icon: 'bell', description: 'Desktop notifications and sound' },
  { id: 'claude', group: 'Agents', label: 'Claude', icon: 'sparkle', description: 'Sign-in, how Claude starts, permissions' },
  { id: 'central', group: 'Agents', label: 'Central', icon: 'comment-discussion', description: 'What it may do, check-ins, spend limit' },
  { id: 'rules', group: 'Agents', label: 'Rules & secrets', icon: 'shield', description: 'What agents may do, and their secrets' },
  { id: 'account', group: 'Account & system', label: 'Account', icon: 'person', description: 'Username, password, signed-in devices' },
  { id: 'browser', group: 'Account & system', label: 'Browser', icon: 'globe', description: 'Profiles: separate logins for each browser' },
  { id: 'capabilities', group: 'Account & system', label: 'Features', icon: 'extensions', description: 'Turn on the browser, files and Telegram' },
  // Machine diagnostics, not the Control panel's code Health; the id stays `health` for old links.
  { id: 'health', group: 'Account & system', label: 'About this machine', icon: 'info', description: 'Checks, data folder, developer tools' },
  // Hidden from the nav unless developer mode is on (./developerMode); links and `?settings=developer` still open it.
  { id: 'developer', group: 'Account & system', label: 'Developer', icon: 'tools', description: 'Every raw value, for troubleshooting' },
] as const satisfies ReadonlyArray<{ id: string; group: (typeof SETTINGS_GROUPS)[number]; label: string; icon: string; description: string }>

export type SectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** Pages that moved out of Settings to the Control side bar (`?ctab=`): a search entry and an old
 *  `?settings=<id>` link still land there (appRoute). Memory, Automations and the Spending report. */
export const MOVED_SETTINGS_PAGES = [
  { id: 'memory', ctab: 'memory', label: 'Memory', description: 'What agents remember and share', keywords: 'remember notes knowledge facts forget suggested' },
  { id: 'automations', ctab: 'automations', label: 'Automations', description: 'Routines that run agents for you', keywords: 'routine routines schedule cron recurring timer job' },
  { id: 'spending', ctab: 'spending', label: 'Spending', description: 'What agents spent today and this week', keywords: 'cost budget money dollars usage bill report' },
] as const

/** Heading of moved pages in Settings search results. */
export const MOVED_GROUP_LABEL = 'Control panel'
