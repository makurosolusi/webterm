// Registry env: Central Agent v2 (RND/29-CA2-ARSITEKTUR-b.md 4.7). Data murni; flag default off kecuali
// WEBTERM_CHANNEL_APPROVAL_BUTTONS (on, F3-a zero-config: kartu gate Telegram langsung bisa ditekan),
// angka = batas aman. `hot` hanya untuk kunci yang pembacanya membaca process.env tiap panggilan (bukti: HOT_PROOF
// di envRegistry.parity.test.ts); sisanya boot. Rentang angka di sini batas konservatif UI, bukan batas pembaca.
import { enumOf, flag, num, type EnvSpec } from './envRegistry.types'

const DEFAULT_TURN_WALL_MS = 120_000
const DEFAULT_TURN_TOKENS = 60_000
const DEFAULT_DAILY_TOKENS = 1_000_000
const DEFAULT_DAILY_SPAWNS = 20
const DEFAULT_AGENT_IDLE_DONE_MS = 45_000
const DEFAULT_TURN_STEPS = 12
const DEFAULT_MAX_INFLIGHT = 3
const DEFAULT_CONTEXT_WINDOW = 128_000
const MAX_NUMBER = 1_000_000_000

// Entri ca2: owner central, section "Central" (sama dengan envRegistry.central.ts), tak di kelompok utama (advanced).
const C = { owner: 'central', section: 'Central', audience: 'advanced' } as const
// Kunci kanal yang sebelumnya dikelompokkan di Central: kini di tab Channels bersama Telegram.
const TGC = { owner: 'channels', section: 'Telegram', audience: 'advanced' } as const
const AGENTS_ON = { key: 'WEBTERM_CENTRAL_AGENTS', oneOf: ['propose', 'auto'], note: 'Needs Central agents set to propose or auto.' }

export const CA2_ENV_SPECS: readonly EnvSpec[] = [
  enumOf('WEBTERM_CENTRAL_AGENTS', 'central', ['off', 'propose', 'auto'], 'off', {
    ...C, dangerNote: 'Central can run real workers (shell, file edits) on the server machine; auto runs without a per-action approval card.', requires: [{ key: 'WEBTERM_CENTRAL_TOOLS', oneOf: ['write'] }, { key: 'WEBTERM_CENTRAL_PLANNER' }, { key: 'WEBTERM_ORCHESTRATOR_RUN' }],
    label: 'Central agents',
    description: 'Set automatically by the Worker orchestrator card (propose = approval card per action) and the Autonomy card (auto = within the envelope); values from .env/shell still win.',
    dangerous: true,
  }),
  flag('WEBTERM_CENTRAL_CHECKPOINT', 'central-context', { ...C, label: 'Conversation checkpoint', description: 'Summarize the central conversation into a checkpoint (deterministic summary, no model call).' }),
  num('WEBTERM_CENTRAL_TURN_WALL_MS', 'central-turn', 1000, 600_000, DEFAULT_TURN_WALL_MS, { ...C, hot: true, label: 'Turn time limit (ms)', description: 'Time limit for one central turn; re-read every turn. The 1,000-600,000 ms range is a conservative Settings bound.' }),
  num('WEBTERM_CENTRAL_TURN_TOKENS', 'central-turn', 1000, MAX_NUMBER, DEFAULT_TURN_TOKENS, { ...C, label: 'Turn token limit', description: 'Recorded; not yet enforced by the production runtime.' }),
  num('WEBTERM_CENTRAL_DAILY_TOKENS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_TOKENS, { ...C, hot: true, label: 'Daily token budget', description: 'Central token limit per UTC day; 0 = unlimited. Applies at the next check.' }),
  num('WEBTERM_CENTRAL_DAILY_SPAWNS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_SPAWNS, { ...C, hot: true, label: 'Daily spawn budget', description: 'Limit on workers central may spawn per UTC day; 0 = no spawning. Applies at the next check.' }),
  num('WEBTERM_CENTRAL_DAILY_COST_MICROS', 'central-budget', 0, MAX_NUMBER, 0, { ...C, hot: true, label: 'Daily cost budget (micros)', description: 'Central cost limit per day in micro-units; 0 = unlimited. Applies at the next check.' }),
  flag('WEBTERM_CENTRAL_SKILLS', 'central', { ...C, hot: true, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Central skills', description: 'Central reads skills from <dataDir>/central/skills (needs tools).' }),
  flag('WEBTERM_CENTRAL_SKILL_PROPOSE', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL_SKILLS' }], label: 'Central skill proposals', description: 'Central may propose new skills for human approval (needs Central skills).' }),
  flag('WEBTERM_CENTRAL_BOTS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }, { key: 'WEBTERM_CHANNELS', oneOf: ['on'] }], label: 'Bot per project', description: 'One bot with a topic per project (needs Telegram and WEBTERM_CHANNELS).' }),
  flag('WEBTERM_CHANNEL_APPROVAL_BUTTONS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }], label: 'Telegram approval buttons', description: 'Approve once / Deny buttons on Telegram approval cards are processed (on by default; needs Telegram). Off ignores button presses; /approve still works.' }, 'on'),
  flag('WEBTERM_KNOWLEDGE', 'central', { ...C, label: 'Knowledge base', description: 'Project knowledge index at <dataDir>/knowledge.db.' }),
  num('WEBTERM_AGENT_IDLE_DONE_MS', 'central', 1000, 3_600_000, DEFAULT_AGENT_IDLE_DONE_MS, {
    ...C, hot: true,
    label: 'Idle = done candidate (ms)',
    description: 'A non-claude worker idle this long with a non-empty diff is treated as a done candidate; re-read on every check.',
  }),
  flag('WEBTERM_CENTRAL_RELIABILITY', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL_AUTONOMY' }], label: 'Autonomy reliability', description: 'Autonomy uses a non-blocking dispatcher, wake, and a per-item breaker (needs autonomy).' }),
  num('WEBTERM_CENTRAL_MAX_INFLIGHT', 'central', 1, 100, DEFAULT_MAX_INFLIGHT, { ...C, label: 'Max concurrent workers', description: 'Global limit on workers autonomy runs at once (reliability mode). Read at boot; applies after restart.' }),
  flag('WEBTERM_AGENT_MAIL', 'central', { ...C, requires: [AGENTS_ON], label: 'Agent mailbox', description: 'Central may leave messages for workers through a mailbox (needs Central agents).' }),
  flag('WEBTERM_CENTRAL_READ_TOOLS', 'central', { ...C, hot: true, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Central read tools', description: 'Central may read projects, nodes, and tasks through read tools (needs tools).' }),
  num('WEBTERM_CENTRAL_CONTEXT_WINDOW', 'central-context', 1000, MAX_NUMBER, DEFAULT_CONTEXT_WINDOW, { ...C, hot: true, label: 'Context window (tokens)', description: 'Model window size for session rotation (70%) and turn rejection (85%); re-read every turn.' }),
  num('WEBTERM_CENTRAL_TURN_STEPS', 'central-turn', 1, 100, DEFAULT_TURN_STEPS, { ...C, hot: true, label: 'Max runtime steps per turn', description: 'Limit on runtime steps in one central turn; re-read every turn. The 1-100 range is a conservative Settings bound.' }),
]
