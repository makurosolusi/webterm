// Settings search as a static index (VS Code / Orca pattern: title + description + keywords per entry),
// so typing searches this list instead of mounting every page (which fired a network load per page and
// could not see pages without `Field` rows). One entry per revealable setting (`field` = its
// `data-field`) plus one per page, so list pages (Rules, Memory, Automations…) are found by what people
// type ("secret", "routine", "budget"). Policy: settings.search.policy.test.ts keeps the index and the
// rendered `data-field` ids in sync, and the labels equal to the ones on screen.
import { CAPABILITIES, type CapabilityId } from '../shared/featureCapabilities'
import { ADVANCED_TEXT } from './advancedLabels'
import { CAPABILITY_KEYWORDS } from './capabilitiesLabels'
import { PROFILES_TEXT } from './claudeLauncher/ClaudeLaunchProfilesCard'
import { PROVIDER_TEXT } from './ClaudeProviderCard'
import { CLAUDE_TEXT } from './ClaudeSettingsSection'
import { APPROVAL_TEXT } from './ApprovalModeControl'
import { ROUTING_TEXT } from './PermissionRoutingField'
import { APPROVAL_LEVEL_TEXT } from '../shared/settings.approvalLevel'
import { HEALTH_TEXT } from './controlPanelLabels'
import { MODELS_TEXT } from './SettingsModels'
import { NOTIFY_TEXT } from './osNotify.settings'
import { CENTRAL_FIELDS } from './centralSettings.registry'
import { CENTRAL_GROUP_TITLE } from './centralSettingsLabels'
import { keybindingFieldId, type SettingsFieldId } from './settings.link'
import { appCommands, FIXED_COMMANDS, SURFACE_COMMANDS, type AppCommandDeps } from './commandRegistry.defaults'
import { chordLabel, commandCategory, type Command } from './commandRegistry'
import { CYCLE_APPROVAL_MODE_COMMAND } from './approvalMode.state'
import { OUTPUT_TOGGLE_COMMAND } from './output/outputCommands'
import { isMacPlatform } from './terminalKeys.platform'
import { MOVED_SETTINGS_PAGES, SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
import type { CentralTab } from './secondarySideBar.store'
import { TOKEN_TEXT } from './tokenAccessLabels'

/** Group of a result: a Settings page, or `control` for pages that moved to the Control side bar. */
export type SearchGroupId = SectionId | 'control'

/** One searchable item. No `field` = the page itself (or a block without a deep-link id). `ctab` = it lives
 *  in the Control side bar now: "Go to" opens that tab instead of a Settings page. */
export interface SettingsSearchEntry {
  page: SearchGroupId
  ctab?: CentralTab
  field?: SettingsFieldId
  label: string
  hint?: string
  keywords?: readonly string[]
}

const kw = (words: string): readonly string[] => words.split(' ')
/** Every level hint, so a search for words in them ("undone", "Deny rules") finds the permission rows. */
const APPROVAL_HINTS = Object.values(APPROVAL_LEVEL_TEXT).map((t) => t.hint).join(' ')

const e = (page: SectionId, field: SettingsFieldId | undefined, label: string, hint?: string, words?: string): SettingsSearchEntry =>
  ({ page, field, label, hint, keywords: words ? kw(words) : undefined })

/** Words per page that are not in its title: what people type when they look for it. */
const PAGE_KEYWORDS: Partial<Record<SectionId, string>> = {
  appearance: 'look theme dark light mode wallpaper background',
  terminal: 'look font color colors cursor keyboard mouse clipboard scrollback buffer shell zsh bash fish',
  keyboard: 'keybinding keybindings shortcut shortcuts hotkey key keys chord record rebind conflict',
  canvas: 'grid node cable edge snap folder',
  notifications: 'alert alerts sound chime notify permission mute',
  claude: 'anthropic agent agents permission approval profile model connection login key proxy',
  central: 'assistant orchestrator autonomy check-in budget spending limit',
  rules: 'secret secrets allow deny block approve approvals permission policy safety always',
  account: 'password username user login session sessions device devices sign out logout',
  capabilities: 'capabilities browser files telegram chromium',
  health: 'status diagnostics doctor problem broken check data folder developer',
  developer: 'raw debug values troubleshooting env',
}

const PAGES: SettingsSearchEntry[] = SETTINGS_SECTIONS.map((s) => e(s.id, undefined, s.label, s.description, PAGE_KEYWORDS[s.id]))

/** Capability cards on Features (Edit files is the Files card's sub-option; Central's three live in Central Agent). */
const CARD_IDS: readonly CapabilityId[] = ['browser', 'files', 'filesWrite', 'telegram']
const CARDS = CARD_IDS.map((id) => e('capabilities', `capability.${id}`, CAPABILITIES[id].title, CAPABILITIES[id].blurb, CAPABILITY_KEYWORDS[id].join(' ')))

const ENTRIES_BY_HAND: SettingsSearchEntry[] = [
  // Appearance (SettingsAppearanceSection.tsx, CanvasBackgroundSection.tsx)
  e('appearance', 'appTheme', 'Theme', 'System follows your computer’s light or dark mode.', 'dark light mode system appearance'),
  e('appearance', 'canvasBackground', 'Canvas background', 'Color, gradient or image behind the nodes, for all workspaces or just this one.', 'wallpaper image gradient color photo'),
  // Terminal › Look, Behavior, Advanced (SettingsTerminalSections.tsx); ids kept from when the look sat on Appearance
  e('terminal', 'terminalTheme', 'Terminal colors', undefined, 'color scheme theme palette dark light preview'),
  e('terminal', 'fontFamily', 'Font', 'Fonts installed on this computer.', 'font family typeface monospace'),
  e('terminal', 'fontSize', 'Font size', undefined, 'text size zoom px'),
  e('terminal', 'fontWeight', 'Normal text weight', undefined, 'font thin'),
  e('terminal', 'fontWeightBold', 'Bold text weight', undefined, 'font'),
  e('terminal', 'terminalLineHeight', 'Line height', 'A multiple of the font size.', 'spacing leading'),
  e('terminal', 'terminalLetterSpacing', 'Letter spacing', 'Extra space between characters.', 'font'),
  e('terminal', 'cursorStyle', 'Cursor style', undefined, 'block bar underline caret'),
  e('terminal', 'cursorBlink', 'Cursor blink', undefined, 'caret'),
  e('terminal', 'copyOnSelect', 'Copy on select', 'Copy text to the clipboard as soon as you select it.', 'clipboard mouse'),
  e('terminal', 'terminalShortcutPolicy', 'Shortcut priority', 'While you type in a terminal, who gets a shortcut that both could use.', 'keyboard shortcuts keys keybinding program'),
  e('terminal', 'scrollbackLines', 'History length', 'How many lines you can scroll back in a terminal.', 'scrollback history lines buffer replay reload'),
  e('terminal', 'defaultShell', 'Default shell', 'Shells installed on this computer.', 'zsh bash fish pwsh'),
  e('terminal', 'terminalFontZoomKeys', 'Keyboard font zoom', 'Change the font size of the focused terminal with the keyboard.', 'shortcut size'),
  e('terminal', 'terminalWordSeparator', 'Word separators', 'Characters that end a word when you double-click to select.', 'select double-click'),
  e('terminal', 'terminalMinContrast', 'Minimum contrast', 'Raise it when colored text is hard to read.', 'accessibility wcag readability'),
  e('terminal', 'drawBoldTextInBrightColors', 'Draw bold text in bright colors', undefined, 'font color'),
  // Claude (ClaudeSettingsSection.tsx, ClaudeProviderCard.tsx, ClaudeLaunchProfilesCard.tsx, SettingsModels.tsx, SettingsAgents.tsx)
  e('claude', 'claude-provider', PROVIDER_TEXT.title, PROVIDER_TEXT.why, 'claude provider anthropic api key proxy gateway custom command envman wrapper login'),
  e('claude', 'claudeLaunchProfiles', PROFILES_TEXT.title, 'How webterm starts Claude.', 'command wrapper envman account default'),
  e('claude', 'agentApprovalLevel', CLAUDE_TEXT.approvalLabel, 'Ask, Auto or Danger.', `permission permissions mode approval approvals skip yolo ask auto danger dangerous bypass hook ${APPROVAL_HINTS}`),
  e('claude', 'permissionRouting', ROUTING_TEXT.label, ROUTING_TEXT.hint, 'permission approval central agent human escalate prompt who decides'),
  e('claude', 'projectApprovalLevels', APPROVAL_TEXT.projectLabel, APPROVAL_TEXT.projectHint, `permission mode project override ask auto danger ${APPROVAL_HINTS}`),
  e('claude', 'model-ladder', MODELS_TEXT.label, MODELS_TEXT.hint, 'opus sonnet haiku effort ladder'),
  e('claude', 'centralClaudeProfileId', PROFILES_TEXT.centralUses, PROFILES_TEXT.centralUsesHint, 'central profile launch'),
  e('claude', 'claudePermissionMode', 'Claude permission mode', CLAUDE_TEXT.rawModeHint, 'permission-mode approval plan'),
  e('claude', 'disabledAgents', 'Agents in the Add menu', 'Turn off agents you don’t use to keep the Add menu short.', 'hide'),
  e('claude', 'customAgents', 'Custom agents', 'Bring your own agent CLI, or wrap a builtin harness.', 'cli proxy wrapper byo'),
  // Canvas (SettingsCanvasSections.tsx)
  e('canvas', 'canvasDots', 'Grid', 'Off, dots, or dots that dragged nodes snap to.', 'dots snap align'),
  e('canvas', 'quickDrag', 'Quick move & resize', 'Hold the keys and drag anywhere on a node.', 'drag modifier'),
  e('canvas', 'nodeStatusBar', 'Status bar', 'Show session and agent details at the bottom of each node, with warnings when something looks wrong.', 'footer statusline anomaly warning pid uptime context cost'),
  e('canvas', 'defaultProjectsFolder', 'Default projects folder', 'Where Clone repository and New project put new folders.', 'directory path clone git'),
  e('canvas', 'gridSize', 'Grid size'),
  e('canvas', 'edgeColor', 'Cable color', 'Color of the cables between nodes.', 'edge line wire'),
  e('canvas', 'edgeWidth', 'Cable thickness', undefined, 'edge line wire width'),
  // Notifications (osNotify.settings.tsx); per-workspace mute is in the workspace menu
  e('notifications', undefined, NOTIFY_TEXT.desktop, NOTIFY_TEXT.desktopHint, 'alert permission browser'),
  e('notifications', undefined, NOTIFY_TEXT.sound, NOTIFY_TEXT.soundHint, 'chime audio'),
  e('notifications', undefined, 'Mute a workspace', 'Right-click a workspace tab › Mute Notifications.', 'silence quiet'),
  // Features (the Spending report moved to the Control panel: MOVED below)
  ...CARDS,
  e('capabilities', 'browserSearchEngine', 'Browser search engine', 'Used when what you type in the address bar is not a web address.', 'google duckduckgo bing'),
  e('claude', undefined, TOKEN_TEXT.title, TOKEN_TEXT.why, CAPABILITY_KEYWORDS.token.join(' ')),
  e('capabilities', 'chromium', ADVANCED_TEXT.chromiumLabel, undefined, CAPABILITY_KEYWORDS.advanced.join(' ')),
  // Health (HealthSection.tsx)
  e('health', undefined, HEALTH_TEXT.dataDir, 'Where webterm keeps its data on this computer.', 'directory path storage'),
  e('health', undefined, HEALTH_TEXT.developerMode, HEALTH_TEXT.developerModeHint, 'debug raw developer'),
]

/** Moved pages: found by name and keywords, opened in the Control side bar. */
const MOVED: SettingsSearchEntry[] = MOVED_SETTINGS_PAGES.map((m) => ({ page: 'control', ctab: m.ctab, label: m.label, hint: m.description, keywords: kw(m.keywords) }))

const noop = (): void => {}
const NOOP_DEPS = new Proxy({}, { get: () => noop }) as AppCommandDeps
/** Commands known without mounting the app: their Keyboard Shortcuts rows are in the search index.
 *  Commands a surface registers while mounted (tabs, layers…) are found by the page's own filter. */
export const INDEXED_COMMANDS: readonly Command[] = [...FIXED_COMMANDS, ...SURFACE_COMMANDS, ...appCommands(NOOP_DEPS), OUTPUT_TOGGLE_COMMAND, CYCLE_APPROVAL_MODE_COMMAND]
const KEYBINDINGS = INDEXED_COMMANDS.map((c) => e('keyboard', keybindingFieldId(c.id), c.label,
  c.defaultKey ? chordLabel(c.defaultKey, isMacPlatform()) : undefined, `shortcut keybinding ${commandCategory(c).toLowerCase()} ${c.id}`))

const CENTRAL = CENTRAL_FIELDS.map((f) => e('central', `central.${f.id}`, f.label, f.hint, CENTRAL_GROUP_TITLE[f.group].toLowerCase()))

/** Every searchable entry, in sidebar order (a page first, then its settings). */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = (() => {
  const all = [...ENTRIES_BY_HAND, ...KEYBINDINGS, ...CENTRAL]
  return [...SETTINGS_SECTIONS.flatMap((s) => [...PAGES.filter((p) => p.page === s.id), ...all.filter((x) => x.page === s.id)]), ...MOVED]
})()

const haystack = (x: SettingsSearchEntry): string =>
  [SETTINGS_SECTIONS.find((s) => s.id === x.page)?.label ?? (x.ctab ? 'control panel' : undefined), x.label, x.hint, x.field, ...(x.keywords ?? [])].join(' ').toLowerCase()
const HAYSTACKS = new Map(SETTINGS_SEARCH_INDEX.map((x) => [x, haystack(x)]))

/** Entries matching a normalized query (space-separated tokens, all must match), grouped by page in sidebar order. */
export function searchSettings(query: string): { page: SearchGroupId; entries: SettingsSearchEntry[] }[] {
  if (!query) return []
  const tokens = query.split(' ')
  const hits = SETTINGS_SEARCH_INDEX.filter((x) => tokens.every((t) => HAYSTACKS.get(x)!.includes(t)))
  const groups: SearchGroupId[] = [...SETTINGS_SECTIONS.map((s) => s.id), 'control']
  return groups.map((page) => ({ page, entries: hits.filter((x) => x.page === page) })).filter((g) => g.entries.length)
}
