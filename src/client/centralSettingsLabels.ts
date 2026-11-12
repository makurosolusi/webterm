// All text of Settings › Central (English, Rule 15): plain words, no env names, no internal jargon.
// Field strings are keyed by the registry id (`centralSettings.registry.ts`), so a new setting = one entry + its text.
import type { CentralGroup } from './centralSettings.registry'

export const CENTRAL_GROUP_TITLE: Readonly<Record<CentralGroup, string>> = {
  status: 'Central',
  autonomy: 'What Central may do',
  cost: 'Daily limit',
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
  retry: 'Retry',
  fixChain: 'Turn on Central',
  fixing: 'Turning on…',
  loadFailed: (why: string): string => `Could not load these settings: ${why}`,
  decrease: (label: string): string => `Decrease ${label}`,
  increase: (label: string): string => `Increase ${label}`,
  confirmAutonomy:
    'Let Central work on its own?\n\nIt will start workers without asking at every step. Only turn it on if you trust the agents that run.',
  checkinUsed: (used: number, limit: number): string => `Used today: ${used} of ${limit}`,
  checkinFailed: 'Could not load the check-in settings.',
  summaryTitle: 'Central Agent',
  summaryLink: 'Managed in Central →',
} as const

/** Label + hint per registry id. */
export const CENTRAL_FIELD_TEXT = {
  central: { label: 'Central Agent', hint: 'An assistant that knows all your projects and nodes, and that you can talk to.' },
  level: { label: 'What Central may do', hint: 'Propose work = Central asks you before each worker it starts.' },
  checkin: { label: 'Let Central check in by itself', hint: 'Central starts a turn on its own when something needs a decision, such as a stalled task or a reminder that came due.' },
  costLimit: { label: 'Daily spending limit', hint: 'Near the limit work moves to cheaper models.' },
  dailySpawns: { label: 'Workers per day', hint: 'How many workers Central may start per day. 0 = none.' },
  checkinLimit: { label: 'Check-ins per day', hint: 'The most check-ins Central may start in one day.' },
  maxInflight: { label: 'Max workers at once', hint: 'How many workers Central runs side by side when it works on its own. Applies to the next worker it starts.' },
} as const

export const LEVEL_TEXT = { none: 'Chat only', workers: 'Propose work (asks first)', autonomy: 'Work on its own' } as const

export const UNIT_TEXT = { workers: 'workers' } as const
