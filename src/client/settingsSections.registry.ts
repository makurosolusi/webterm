// The Settings sections (nav entry + page header) in one React-free module, so both the lazily loaded
// panel (SettingsPanel.tsx) and the URL whitelist (appRoute.ts, start-up chunk) read the same list.
import { CANVAS_BG_SECTION } from './canvasBackground.open'

/** Sidebar group headings, in display order. */
export const SETTINGS_GROUPS = ['Editor', 'Agents', 'Workspace', 'System'] as const

/** Settings sections: nav entry + page header, one place, listed in group order. `icon` is a codicon name; `description` says what is inside. */
export const SETTINGS_SECTIONS = [
  { id: 'terminal', group: 'Editor', label: 'Terminal', icon: 'terminal', description: 'Font, colors, cursor, scrollback' },
  { id: 'interaction', group: 'Editor', label: 'Interaction', icon: 'keyboard', description: 'Copy & paste, shortcuts, selection' },
  { id: 'shell', group: 'Editor', label: 'Shell & buffer', icon: 'server-process', description: 'Which shell to start, replay buffer' },
  { id: 'agent', group: 'Agents', label: 'Agent', icon: 'hubot', description: 'Permissions, custom agents, profiles' },
  { id: 'central', group: 'Agents', label: 'Central Agent', icon: 'comment-discussion', description: 'Autonomy, spending, abilities' },
  { id: 'rules', group: 'Agents', label: 'Rules & approvals', icon: 'shield', description: 'What agents may do without asking' },
  { id: 'memory', group: 'Agents', label: 'Memory', icon: 'book', description: 'What agents remember and share' },
  { id: 'automations', group: 'Agents', label: 'Automations', icon: 'clock', description: 'Routines that run agents for you' },
  { id: 'spending', group: 'Agents', label: 'Spending', icon: 'credit-card', description: 'Spending and limits that pause work' },
  { id: 'canvas', group: 'Workspace', label: 'Canvas', icon: 'layout', description: 'Grid, new node size, search engine' },
  { id: CANVAS_BG_SECTION, group: 'Workspace', label: 'Canvas background', icon: 'paintcan', description: 'Color, gradient or image behind nodes' },
  { id: 'account', group: 'System', label: 'Account', icon: 'account', description: 'Username, password, signed-in devices' },
  { id: 'capabilities', group: 'System', label: 'Capabilities', icon: 'extensions', description: 'Turn features on or off' },
  { id: 'health', group: 'System', label: 'Health', icon: 'pulse', description: 'Is everything working on this machine' },
  { id: 'developer', group: 'System', label: 'Developer', icon: 'tools', description: 'Every raw value, for troubleshooting' },
] as const satisfies ReadonlyArray<{ id: string; group: (typeof SETTINGS_GROUPS)[number]; label: string; icon: string; description: string }>

export type SectionId = (typeof SETTINGS_SECTIONS)[number]['id']
