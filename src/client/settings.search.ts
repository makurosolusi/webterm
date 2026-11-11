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
import { CENTRAL_FIELDS } from './centralSettings.registry'
import { CENTRAL_GROUP_TITLE, CENTRAL_TEXT } from './centralSettingsLabels'
import { COST_TEXT } from './CostPanel'
import type { SettingsFieldId } from './settings.link'
import { SETTINGS_SECTIONS, type SectionId } from './settingsSections.registry'
import { TOKEN_TEXT } from './tokenAccessLabels'

/** One searchable item. No `field` = the page itself (or a block without a deep-link id). */
export interface SettingsSearchEntry {
  page: SectionId
  field?: SettingsFieldId
  label: string
  hint?: string
  keywords?: readonly string[]
}

const kw = (words: string): readonly string[] => words.split(' ')
const e = (page: SectionId, field: SettingsFieldId | undefined, label: string, hint?: string, words?: string): SettingsSearchEntry =>
  ({ page, field, label, hint, keywords: words ? kw(words) : undefined })

/** Words per page that are not in its title: what people type when they look for it. */
const PAGE_KEYWORDS: Partial<Record<SectionId, string>> = {
  terminal: 'appearance look font theme color dark light',
  interaction: 'keyboard mouse clipboard',
  shell: 'zsh bash fish buffer folder',
  agent: 'claude permission approval profile model',
  central: 'assistant orchestrator autonomy check-in budget',
  rules: 'secret secrets allow deny block approve permission policy safety',
  memory: 'remember notes knowledge facts forget',
  automations: 'routine routines schedule cron recurring timer job',
  spending: 'cost budget money dollars usage bill report',
  canvas: 'grid node cable edge',
  background: 'wallpaper image gradient color photo',
  account: 'password username user login session sessions device devices sign out logout',
  capabilities: 'features browser files telegram',
  health: 'status diagnostics doctor problem broken check',
  developer: 'raw debug values troubleshooting env',
}

const PAGES: SettingsSearchEntry[] = SETTINGS_SECTIONS.map((s) => e(s.id, undefined, s.label, s.description, PAGE_KEYWORDS[s.id]))

/** Capability cards of their own (Central, Workers and Autonomy share the one Central row). */
const CARD_IDS: readonly CapabilityId[] = ['browser', 'files', 'filesWrite', 'telegram']
const CARDS = CARD_IDS.map((id) => e('capabilities', `capability.${id}`, CAPABILITIES[id].title, CAPABILITIES[id].blurb, CAPABILITY_KEYWORDS[id].join(' ')))

const ENTRIES_BY_HAND: SettingsSearchEntry[] = [
  // Terminal (SettingsTerminalSections.tsx)
  e('terminal', 'fontSize', 'Font size', undefined, 'text size zoom px'),
  e('terminal', 'fontFamily', 'Font family', 'A CSS font list. Monospace fonts only.', 'typeface monospace'),
  e('terminal', 'fontWeight', 'Normal text weight', undefined, 'font thin'),
  e('terminal', 'fontWeightBold', 'Bold text weight', undefined, 'font'),
  e('terminal', 'drawBoldTextInBrightColors', 'Draw bold text in bright colors', undefined, 'font color'),
  e('terminal', 'terminalLineHeight', 'Line height', 'A multiple of the font size.', 'spacing leading'),
  e('terminal', 'terminalLetterSpacing', 'Letter spacing', 'Extra horizontal space between cells.', 'font'),
  e('terminal', 'terminalTheme', 'Color scheme', undefined, 'theme colors palette dark light'),
  e('terminal', 'appTheme', 'App theme', 'The look of the app chrome (panels, node headers, menus).', 'dark light mode appearance'),
  e('terminal', 'terminalMinContrast', 'Minimum contrast', 'Foreground/background contrast ratio.', 'accessibility wcag readability'),
  e('terminal', 'cursorStyle', 'Cursor style', undefined, 'block bar underline caret'),
  e('terminal', 'cursorInactiveStyle', 'Inactive cursor style', undefined, 'caret outline'),
  e('terminal', 'cursorBlink', 'Cursor blink', undefined, 'caret'),
  e('terminal', 'terminalGpuRendering', 'GPU rendering', undefined, 'webgl performance renderer'),
  e('terminal', 'scrollbackLines', 'Terminal scrollback', 'How far up you can scroll inside a terminal node.', 'history lines buffer'),
  // Interaction
  e('interaction', 'terminalWordSeparator', 'Word separators', 'Characters that end a word on double-click selection.', 'select double-click'),
  e('interaction', 'copyOnSelect', 'Copy on select', 'Copy a finished mouse selection to the system clipboard.', 'clipboard'),
  e('interaction', 'terminalMiddleClickPaste', 'Middle-click paste', undefined, 'mouse clipboard'),
  e('interaction', 'terminalFontZoomKeys', 'Keyboard font zoom', 'Change the font size of the focused terminal with the keyboard.', 'shortcut size'),
  e('interaction', 'terminalShortcutPolicy', 'Shortcut priority', 'Who wins while a terminal holds keyboard focus.', 'keyboard keys keybinding'),
  e('interaction', 'openMarkdownPreview', 'Open Markdown as preview', undefined, 'md editor render'),
  // Shell & buffer
  e('shell', 'defaultShell', 'Default shell', 'Empty = use the system default shell.', 'zsh bash fish pwsh'),
  e('shell', 'scrollbackBytes', 'Server replay buffer', 'Raw terminal output replayed when the tab reloads.', 'scrollback reload'),
  e('shell', 'defaultProjectsFolder', 'Default projects folder', 'Where Clone repository and New project put new folders.', 'directory path clone git'),
  // Agent (SettingsAgents.tsx, SettingsModels.tsx, ClaudeLaunchProfilesCard.tsx)
  e('agent', 'skipApprovals', 'Skip approvals', 'Central and every Claude agent act without asking you first.', 'yolo dangerous permission ask'),
  e('agent', 'defaultAgent', 'Agent default', 'The agent launched by the quick-add button.'),
  e('agent', 'claudePermissionMode', 'Claude permission mode', undefined, 'permission-mode approval plan'),
  e('agent', 'hookReplyApprovals', 'Hook approvals from the canvas', undefined, 'approve deny permission'),
  e('agent', 'disabledAgents', 'Agents in the Add menu', 'Turn off agents you don’t use to keep the Add menu short.', 'hide'),
  e('agent', 'claudeLaunchProfiles', PROFILES_TEXT.title, 'How webterm starts Claude.', 'command wrapper envman account'),
  e('agent', 'defaultClaudeProfileId', PROFILES_TEXT.defaultFor, undefined, 'profile'),
  e('agent', 'model-ladder', 'Models', 'A model ladder picks the model and effort for each task.', 'opus sonnet haiku effort'),
  e('agent', 'projectModels', 'Per-workspace model', 'Pin a model or effort for one workspace.', 'override project'),
  // Canvas (SettingsCanvasSections.tsx)
  e('canvas', 'gridSize', 'Grid size'),
  e('canvas', 'snapToGrid', 'Snap to grid', 'While on, dragging a node rounds its position to the grid.', 'align'),
  e('canvas', 'quickDrag', 'Quick move & resize', 'Hold the keys and drag anywhere on a node.', 'drag modifier'),
  e('canvas', 'canvasDots', 'Grid dots', 'Visual only — snapping is unchanged.'),
  e('canvas', 'edgeColor', 'Cable color', 'Color of the cables between nodes.', 'edge line wire'),
  e('canvas', 'edgeWidth', 'Cable thickness', undefined, 'edge line wire width'),
  e('canvas', 'defaultNodeWidth', 'New node width', 'Existing nodes keep the size saved with them.', 'size'),
  e('canvas', 'defaultNodeHeight', 'New node height', undefined, 'size'),
  e('canvas', 'browserSearchEngine', 'Browser search engine', 'Used when what you type in the address bar is not a web address.', 'google duckduckgo bing'),
  // Spending, Capabilities
  e('spending', 'cost-panel', COST_TEXT.title, COST_TEXT.intro, 'cost money report usage'),
  e('capabilities', 'capability.central', CENTRAL_TEXT.summaryTitle, CAPABILITIES.central.blurb, [...CAPABILITY_KEYWORDS.central, ...CAPABILITY_KEYWORDS.workers, ...CAPABILITY_KEYWORDS.autonomy].join(' ')),
  ...CARDS,
  e('capabilities', 'claude-provider', PROVIDER_TEXT.title, PROVIDER_TEXT.why, 'anthropic api key proxy gateway custom command envman wrapper'),
  e('capabilities', undefined, TOKEN_TEXT.title, TOKEN_TEXT.why, CAPABILITY_KEYWORDS.token.join(' ')),
  e('capabilities', 'chromium', ADVANCED_TEXT.chromiumLabel, undefined, CAPABILITY_KEYWORDS.advanced.join(' ')),
  e('capabilities', 'agentEngine', ADVANCED_TEXT.engineLabel, ADVANCED_TEXT.engineRecheckHint, 'claude install sign in'),
]

const CENTRAL = CENTRAL_FIELDS.map((f) => e('central', `central.${f.id}`, f.label, f.hint, CENTRAL_GROUP_TITLE[f.group].toLowerCase()))

/** Every searchable entry, in sidebar order (a page first, then its settings). */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = (() => {
  const all = [...ENTRIES_BY_HAND, ...CENTRAL]
  return SETTINGS_SECTIONS.flatMap((s) => [...PAGES.filter((p) => p.page === s.id), ...all.filter((x) => x.page === s.id)])
})()

const haystack = (x: SettingsSearchEntry): string =>
  [SETTINGS_SECTIONS.find((s) => s.id === x.page)?.label, x.label, x.hint, x.field, ...(x.keywords ?? [])].join(' ').toLowerCase()
const HAYSTACKS = new Map(SETTINGS_SEARCH_INDEX.map((x) => [x, haystack(x)]))

/** Entries matching a normalized query (space-separated tokens, all must match), grouped by page in sidebar order. */
export function searchSettings(query: string): { page: SectionId; entries: SettingsSearchEntry[] }[] {
  if (!query) return []
  const tokens = query.split(' ')
  const hits = SETTINGS_SEARCH_INDEX.filter((x) => tokens.every((t) => HAYSTACKS.get(x)!.includes(t)))
  return SETTINGS_SECTIONS.map((s) => ({ page: s.id, entries: hits.filter((x) => x.page === s.id) })).filter((g) => g.entries.length)
}
