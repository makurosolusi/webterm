// All text of Settings › Central (English, Rule 15): plain words, no env names, no internal jargon.
// Field strings are keyed by the registry id (`centralSettings.registry.ts`), so a new setting = one entry + its text.
import type { CentralGroup } from './centralSettings.registry'

export const CENTRAL_GROUP_TITLE: Readonly<Record<CentralGroup, string>> = {
  status: 'Central Agent',
  autonomy: 'What Central may do',
  cost: 'Spending',
  advanced: 'Advanced',
}

export const CENTRAL_TEXT = {
  offReason: 'Turn on Central Agent first.',
  workersOffReason: 'Choose "Full" first.',
  autonomyOffReason: 'Choose "Full, on its own" first.',
  unavailable: 'Not available on this server.',
  locked: 'Locked by the server environment.',
  loading: 'Loading…',
  retry: 'Retry',
  fixChain: 'Turn on Central',
  fixing: 'Turning on…',
  loadFailed: (why: string): string => `Could not load these settings: ${why}`,
  decrease: (label: string): string => `Decrease ${label}`,
  increase: (label: string): string => `Increase ${label}`,
  confirmAutonomy: {
    title: 'Let Central work on its own?',
    body: 'It will start workers without asking at every step. Only turn this on if you trust the agents that run.',
    action: 'Let it work on its own',
  },
  cancel: 'Cancel',
  checkinUsed: (used: number, limit: number): string => `Used today: ${used} of ${limit}`,
  checkinCount: (n: number): string => `${n} per day`,
  capabilitiesFailed: 'Could not load Central.',
  checkinFailed: 'Could not load the check-in settings.',
} as const

/** Label + hint per registry id. */
export const CENTRAL_FIELD_TEXT = {
  central: { label: 'Central Agent', hint: 'An assistant that knows all your projects and nodes, and that you can talk to.' },
  level: { label: 'What Central may do', hint: 'Full: Central acts on its own (starts workers, drives the canvas, runs tools) and never writes code itself; workers do. Full, on its own: it also keeps going without being asked. Chat only: Central answers but starts no workers. To make it ask first, set "Workers Central may start" to propose in Advanced.' },
  checkin: { label: 'Let Central check in by itself', hint: 'Central starts a turn on its own when something needs a decision, such as a stalled task or a reminder that came due.' },
  tidy: { label: 'Tidy up finished workers', hint: 'Central folds away workers it started once they finish and you have their result, then closes them after a couple of hours. It never touches your own nodes.' },
  costLimit: { label: 'Daily spending limit', hint: 'At 80% work moves to cheaper models; at 100% Central, routines, plans and bake-offs pause until the next day. Empty = no limit.' },
  spendWarning: { label: 'Warn when today\'s spend passes $10', hint: 'One notice per day. It never stops work. Turning it off also closes the open warnings.' },
  dailySpawns: { label: 'Workers per day', hint: 'How many workers Central may start per day. 0 = none.' },
  checkinLimit: { label: 'Check-ins per day', hint: 'The most check-ins Central may start in one day.' },
  maxInflight: { label: 'Max workers at once', hint: 'How many workers Central runs side by side when it works on its own. Applies to the next worker it starts.' },
} as const

export const LEVEL_TEXT = { none: 'Chat only', workers: 'Full', autonomy: 'Full, on its own' } as const

export const UNIT_TEXT = { workers: 'workers' } as const
