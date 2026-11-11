// The Settings sections (nav entry + page header) in one React-free module, so both the lazily loaded
// panel (SettingsPanel.tsx) and the URL whitelist (appRoute.ts, start-up chunk) read the same list.
import { CANVAS_BG_SECTION } from './canvasBackground.open'

/** Sidebar group headings, in display order. */
export const SETTINGS_GROUPS = ['General', 'Agents', 'Safety', 'Workspace', 'System'] as const

/** Settings sections: nav entry + page header, one place, listed in group order. `icon` is a codicon name; `description` says what is inside. */
export const SETTINGS_SECTIONS = [
  { id: 'terminal', group: 'General', label: 'Terminal', icon: 'terminal', description: 'Font, colors, cursor, scrollback' },
  { id: 'interaction', group: 'General', label: 'Interaction', icon: 'keyboard', description: 'Copy & paste, shortcuts, selection' },
  { id: 'shell', group: 'General', label: 'Shell & buffer', icon: 'server-process', description: 'Which shell to start, replay buffer' },
  { id: 'agent', group: 'Agents', label: 'Agent', icon: 'hubot', description: 'Permissions, custom agents, profiles' },
  { id: 'central', group: 'Agents', label: 'Central Agent', icon: 'comment-discussion', description: 'Autonomy, spending, abilities' },
  { id: 'rules', group: 'Safety', label: 'Rules & secrets', icon: 'shield', description: 'What agents may do, and secrets' },
  { id: 'canvas', group: 'Workspace', label: 'Canvas', icon: 'layout', description: 'Grid, new node size, search engine' },
  { id: CANVAS_BG_SECTION, group: 'Workspace', label: 'Canvas background', icon: 'paintcan', description: 'Color, gradient or image behind nodes' },
  { id: 'account', group: 'System', label: 'Account', icon: 'account', description: 'Username, password, signed-in devices' },
  { id: 'capabilities', group: 'System', label: 'Capabilities', icon: 'extensions', description: 'Turn features on or off' },
  { id: 'health', group: 'System', label: 'Health', icon: 'pulse', description: 'Is everything working on this machine' },
  { id: 'developer', group: 'System', label: 'Developer', icon: 'tools', description: 'Every raw value, for troubleshooting' },
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
