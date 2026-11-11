// All text of Settings › Central Agent (English, Rule 15): plain words, no env names, no internal jargon.
// Field strings are keyed by the registry id (`centralSettings.registry.ts`), so a new setting = one entry + its text.
import type { CentralGroup } from './centralSettings.registry'

export const CENTRAL_GROUP_TITLE: Readonly<Record<CentralGroup, string>> = {
  status: 'Status & setup',
  autonomy: 'Autonomy & approvals',
  cost: 'Model & cost',
  abilities: 'Abilities',
  telegram: 'Telegram',
  advanced: 'Advanced',
}

export const CENTRAL_TEXT = {
  sectionHint: 'Everything about the Central Agent in one place.',
  offReason: 'Turn on Central Agent first.',
  workersOffReason: 'Choose "Propose work" or "Work on its own" first.',
  autonomyOffReason: 'Choose "Work on its own" first.',
  unavailable: 'Not available on this server.',
  locked: 'Locked by the server environment.',
  loading: 'Loading…',
  saving: 'Saving…',
  retry: 'Retry',
  loadFailed: (why: string): string => `Could not load these settings: ${why}`,
  saveFailed: (why: string): string => `Could not save: ${why}`,
  experiments: 'Experiments',
  decrease: (label: string): string => `Decrease ${label}`,
  increase: (label: string): string => `Increase ${label}`,
  open: 'Open',
  browserOff: 'The browser is off.',
  browserAgentsOn: 'Agents may drive it.',
  browserAgentsOff: 'Agents may not drive it.',
  telegramOn: 'Connected.',
  telegramStep: 'Needs a bot token.',
  telegramOff: 'Not connected.',
  confirmAutonomy:
    'Let Central work on its own?\n\nIt will start workers without asking at every step. Only turn it on if you trust the agents that run.',
  checkinUsed: (used: number, limit: number): string => `Used today: ${used} of ${limit}`,
  checkinFailed: 'Could not load the check-in settings.',
  summaryTitle: 'Central Agent',
  summaryLink: 'Managed in Central Agent →',
} as const

/** Label + hint per registry id. */
export const CENTRAL_FIELD_TEXT = {
  central: { label: 'Central Agent', hint: 'An assistant that knows all your projects and nodes, and that you can talk to.' },
  engine: { label: 'Engine', hint: 'What runs Central. Check again after installing or signing in to Claude.' },
  profile: { label: 'Claude profile', hint: 'Which launch profile starts Central.' },
  profiles: { label: 'Launch profiles', hint: 'Add or edit the commands that start Claude.' },
  level: { label: 'What Central may do', hint: 'Propose work = every worker waits for your approval card.' },
  askEachWorker: { label: 'Ask before each worker runs', hint: 'Show an approval card before a worker starts.' },
  dailySpawns: { label: 'Workers per day', hint: 'How many workers Central may start per day. 0 = none.' },
  checkin: { label: 'Let Central check in by itself', hint: 'Central starts a turn on its own when something needs a decision, such as a stalled task or a reminder that came due.' },
  checkinLimit: { label: 'Check-ins per day', hint: 'The most check-ins Central may start in one day.' },
  costLimit: { label: 'Daily spending limit', hint: 'Near the limit work moves to cheaper models.' },
  ladder: { label: 'Model ladder & per-workspace overrides', hint: 'Which model each kind of task uses.' },
  report: { label: 'Spending report', hint: 'What Central and its workers spent.' },
  skills: { label: 'Use approved skills', hint: 'Central may use skills you reviewed and approved.' },
  skillPropose: { label: 'Suggest new skills', hint: 'Central may draft a skill for you to review.' },
  checkpoint: { label: 'Summarize long conversations', hint: 'Keeps long chats going by summarizing older turns.' },
  browser: { label: 'Browser', hint: 'Set in the Browser card.' },
  telegram: { label: 'Telegram', hint: 'Talk to Central from Telegram. Set in the Telegram card.' },
  model: { label: 'Model', hint: 'Auto follows the model ladder.' },
  turnSeconds: { label: 'Reply time limit', hint: 'Longest time one reply may take.' },
  turnSteps: { label: 'Steps per reply', hint: 'Most actions Central may take in one reply.' },
  contextWindow: { label: 'Context window', hint: 'How much conversation the model can hold.' },
  dailyTokens: { label: 'Daily token budget', hint: 'Most tokens Central may use per day.' },
  maxInflight: { label: 'Max workers at once', hint: 'How many workers Central runs side by side when it works on its own. Applies to the next worker it starts.' },
  knowledge: { label: 'Project knowledge', hint: 'Central builds a searchable index of your projects.' },
  reliability: { label: 'Steadier autonomy', hint: 'Stops retrying a task that keeps failing the same way, and tidies up workers left from before a restart.' },
  mail: { label: 'Agent mail', hint: 'Central may leave messages for its workers.' },
} as const

export const LEVEL_TEXT = { none: 'Chat only', workers: 'Propose work (you approve)', autonomy: 'Work on its own' } as const

export const MODEL_TEXT = { auto: 'Auto', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' } as const

export const UNIT_TEXT = { seconds: 's', workers: 'workers', steps: 'steps' } as const

/** Preset label: 128000 -> "128K", 1000000 -> "1M", 0 -> "No limit". */
export function tokensLabel(n: number): string {
  if (n === 0) return 'No limit'
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  return `${n / 1000}K`
}
