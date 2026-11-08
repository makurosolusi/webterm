// Seluruh string UI panel kontrol Central Agent v2 (Rule 15): satu tempat, tanpa literal di komponen.
import type { ControlLevel } from '../../server/central/contracts/level.types'

export const CL = {
  panelTitle: 'Central control',
  tabsLabel: 'Central control sections',
  tabStatus: 'Status',
  tabAbilities: 'Abilities',
  tabAgents: 'Agents',
  tabSkills: 'Skills',
  loading: 'Loading…',
  refresh: 'Refresh',
  loadMore: 'Load more',
  empty: 'Nothing to show.',
  loadFailed: 'Could not load this section. Use Refresh to try again.',
  actionFailed: 'The action did not go through. Try again in a moment.',
  turnOn: 'Turn on',
  skillsOff: 'Central skills are off. With skills on, Central can use reusable instructions, and new ones wait here for your review.',
  agentsOff: 'Central agents are off. With the worker orchestrator on, the workers Central starts are listed here.',
  privacyLabel: 'Free model: prompts and repository content are sent to the model provider. Use a credentialed provider for sensitive data.',
  levelHeading: 'What Central may do',
  limited: 'Limited by your highest allowed level.',
  change: 'Change',
  changeLabel: 'Change in Central settings',
  approvalsSkipped: 'Approvals: skipped — Central acts without asking',
  changeApprovalsLabel: 'Change in Agent settings',
  budgetHeading: "Today's budget",
  tokens: 'Tokens',
  spawns: 'Workers',
  noLimit: 'No limit',
  noneAllowed: 'None allowed',
  tokensUsed: (used: string, limit: string) => `${used} of ${limit} tokens today`,
  spawnsUsed: (used: string, limit: string) => `${used} of ${limit} workers started today`,
  haltButton: 'Stop Central',
  haltPrompt: 'Stops everything Central is doing and turns it off until you turn it back on in Settings.',
  haltConfirm: 'Yes, stop Central',
  haltCancel: 'Cancel',
  haltReason: 'Reason (optional)',
  haltDone: 'Central is stopped. Turn it back on in Settings.',
  agentsHeading: 'Agents',
  agentState: 'State',
  agentOwner: 'Owner',
  agentRunner: 'Runner',
  relay: 'Relay',
  relayPrompt: 'Message to relay',
  relaySend: 'Send',
  close: 'Close',
  approvalRequested: 'Approval requested. Decide it in the Needs-you list of the Central chat.',
  actionDone: 'Done.',
  confirmLabel: (phrase: string) => `Type ${phrase} to confirm`,
  skillsHeading: 'Skill review',
  skillLint: 'Lint',
  skillLintOk: 'Lint passed',
  skillLintFail: 'Lint failed',
  skillDiff: 'Diff',
  skillScore: 'Eval score',
  skillApprove: 'Approve skill',
  skillRollback: 'Rollback',
  memoryHeading: "Central's memory",
  memoryEmpty: 'Central has not remembered anything yet.',
  memoryIntro: 'What Central remembers from its chats. Read-only.',
  memoryScope: 'Scope',
  memoryTrust: 'Trust',
  memoryKind: 'Kind',
  memoryKey: 'Key',
  memoryValue: 'Value',
  secretMasked: '[hidden: looks like a password or key]',
} as const

/**
 * Short code and plain name of each ladder level (RND/28b §4.1). The code comes first: the Timeline badge
 * shows only it. Wording follows controlGuard: a worker start needs act_gated, R2 asks below act_envelope, R3 always asks.
 */
export const LEVEL_NAMES: Record<ControlLevel, string> = {
  off: 'L0 Off',
  observe: 'L1 Chat only',
  propose: 'L2 Proposes work, you approve',
  act_gated: 'L3 Starts workers, asks before risky steps',
  act_envelope: 'L4 Works on its own within its limits',
}

/** One plain sentence per level, shown under the level name on the Status tab. */
export const LEVEL_MEANING: Record<ControlLevel, string> = {
  off: 'Central is turned off and does nothing.',
  observe: 'Central can chat and look things up, but changes nothing.',
  propose: 'Central suggests plans and work; nothing runs until you approve it.',
  act_gated: 'Central can start workers on its own and asks you before anything risky.',
  act_envelope: 'Central works on its own within its budget and asks only before the riskiest steps.',
}

/** Abilities tab: what Central can do at the current level (`GET /api/central/tools`). */
export const AB = {
  intro: 'Everything Central can do at your current level.',
  filter: 'Show',
  all: 'All',
  levelOff: 'Central is turned off, so it can do none of these right now.',
  none: 'Nothing matches this filter.',
  footnote: 'Your rules in Settings › Rules & approvals, the daily budget and worker limits can still stop or pause a tool.',
  openRules: 'Open Rules & approvals',
  noTools: 'Central has no tools yet.',
  skillsHeading: 'Skills Central can use',
  skillsNone: 'No skills yet. Skills you approve in the Skills tab show up here.',
  skillsOff: 'Skills are turned off. Turn them on in the Skills tab.',
  /** [one, many] */
  count: { auto: ['runs on its own', 'run on their own'], asks: ['asks you first', 'ask you first'], blocked: ['not allowed at this level', 'not allowed at this level'], off: ['turned off', 'turned off'] },
  badge: { auto: 'Runs on its own', asks: 'Asks you first', blocked: 'Not allowed at this level', off: 'Turned off' },
  filterLabel: { auto: 'Runs on its own', asks: 'Asks you', blocked: 'Not allowed' },
  group: {
    projects: 'Projects & nodes', workers: 'Workers', tasks: 'Tasks & plans', memory: 'Memory', browser: 'Browser',
    skills: 'Skills', channels: 'Telegram & channels', approvals: 'Approvals', other: 'Other',
  },
} as const
