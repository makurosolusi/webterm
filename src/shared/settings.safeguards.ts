// Every setting defaults to its most capable value (docs/decisions/settings-overhaul.md, wave 3). The few that stay
// restrictive are real safeguards, listed here with the one sentence the UI shows next to the control. Keys are a
// Settings key, an env key, or a page id that is neither (secret access, Deny rules). The policy test
// (server/settings.defaults.policy.test.ts) fails for any boolean default that is off without a reason.

export const SAFEGUARDS: Readonly<Record<string, string>> = {
  WEBTERM_CENTRAL_AUTONOMY: 'Off by default: working on its own starts real workers (shell, file edits, commits) without asking.',
  WEBTERM_RUN_REQUIRE_APPROVAL: 'Off by default (owner decision 2026-11-17: bypass, no complicated permissions); turn it on to approve each worker run first.',
  WEBTERM_TRUST_PROXY: 'Off by default: without a trusted proxy in front, anyone could fake their address and dodge throttling.',
  WEBTERM_CENTRAL_DAILY_COST_MICROS: 'The one hard stop on spend: once reached, Central stops for the day.',
  WEBTERM_CENTRAL_DAILY_SPAWNS: 'Caps how many workers, and so how much spend, Central can start in one day.',
  WEBTERM_CENTRAL_MAX_INFLIGHT: 'Caps how many workers run at once, so spend and load stay predictable.',
  centralCheckinDailyLimit: 'Caps the turns Central starts by itself, so it never spends without you in the loop for long.',
  dailySpendWarning: 'Cost is covered by the model plan; spend warnings are noise unless you ask for them.',
  secretAccess: 'Agents ask before they use a secret, because a leaked secret cannot be taken back.',
  denyRules: 'Deny rules hold even in Bypass mode, so a block you set is never skipped.',
}

/** UI field id -> its SAFEGUARDS key, where the two differ (Central rows are `central.<id>`, ../client/settings.link). */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  'central.level': 'WEBTERM_CENTRAL_AUTONOMY',
  'central.costLimit': 'WEBTERM_CENTRAL_DAILY_COST_MICROS',
  'central.dailySpawns': 'WEBTERM_CENTRAL_DAILY_SPAWNS',
  'central.maxInflight': 'WEBTERM_CENTRAL_MAX_INFLIGHT',
  'central.checkinLimit': 'centralCheckinDailyLimit',
  'central.spendWarning': 'dailySpendWarning',
}

/** The safeguard reason a field shows, or undefined when its default is simply the most capable one. */
export function safeguardFor(id: string | undefined): string | undefined {
  return id === undefined ? undefined : SAFEGUARDS[FIELD_ALIASES[id] ?? id]
}
