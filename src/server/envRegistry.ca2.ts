// Registry env: Central Agent v2 (RND/29-CA2-ARSITEKTUR-b.md 4.7). Data murni; flag default off kecuali
// WEBTERM_CHANNEL_APPROVAL_BUTTONS (on, F3-a zero-config: kartu gate Telegram langsung bisa ditekan) dan
// WEBTERM_CENTRAL_CHECKPOINT (on, zero-config: Central selalu tahu keadaan kerja),
// angka = batas aman. `hot` hanya untuk kunci yang pembacanya membaca process.env tiap panggilan (bukti: HOT_PROOF
// di envRegistry.parity.test.ts); sisanya boot. Rentang angka di sini batas konservatif UI, bukan batas pembaca.
import { enumOf, flag, num, type EnvSpec } from './envRegistry.types'

const DEFAULT_TURN_WALL_MS = 120_000
// Input-equivalent tokens (cache reads 0.1x, writes 1.25x, budgetStore.guardTokens). Was 1M before cache
// tokens were counted: an observed heavy day reached ~1.13M, which would have halted Central.
const DEFAULT_DAILY_TOKENS = 10_000_000
/** Soft daily spend warning: crossing it raises one Needs-you notice per UTC day; it never blocks work. */
export const DAILY_COST_WARNING_MICROS = 10_000_000
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
const AGENTS_ON = { key: 'WEBTERM_CENTRAL_AGENTS', oneOf: ['propose', 'auto'], note: 'Needs the Worker orchestrator on.' }

export const CA2_ENV_SPECS: readonly EnvSpec[] = [
  enumOf('WEBTERM_CENTRAL_AGENTS', 'central', ['off', 'propose', 'auto'], 'off', {
    ...C, dangerNote: 'Central can run real workers (shell, file edits) on the server machine; auto runs without a per-action approval card.', requires: [{ key: 'WEBTERM_CENTRAL_TOOLS', oneOf: ['write'] }, { key: 'WEBTERM_CENTRAL_PLANNER' }, { key: 'WEBTERM_ORCHESTRATOR_RUN' }],
    label: 'Workers Central may start',
    description: 'Set by the Worker orchestrator card (Central asks you to approve each worker) and the Autonomy card (Central starts workers on its own within its limits). A value in .env or the shell still wins.',
    dangerous: true,
  }),
  flag('WEBTERM_CENTRAL_CHECKPOINT', 'central-context', { ...C, hot: true, label: 'Summarize long conversations', description: 'Keep Central up to date in every reply (time, open work, pinned state) and keep a running summary so long chats stay on track. On by default; turn off only for the bare conversation.' }, 'on'),
  num('WEBTERM_CENTRAL_TURN_WALL_MS', 'central-turn', 1000, 600_000, DEFAULT_TURN_WALL_MS, { ...C, hot: true, unit: 'ms', label: 'Time limit per reply', description: 'How long Central may work on one reply, in milliseconds (default 120,000 = 2 minutes). Applies from the next reply.' }),
  num('WEBTERM_CENTRAL_DAILY_TOKENS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_TOKENS, { ...C, hot: true, unit: 'tokens', label: 'Daily token limit', description: 'How many tokens Central may use per day (UTC). Cached input counts for less. Default 10,000,000; 0 = no limit.' }),
  num('WEBTERM_CENTRAL_DAILY_SPAWNS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_SPAWNS, { ...C, hot: true, unit: 'workers', label: 'Workers per day', description: 'How many workers Central may start per day (UTC). 0 = no spawning.' }),
  num('WEBTERM_CENTRAL_DAILY_COST_MICROS', 'central-budget', 0, MAX_NUMBER, 0, { ...C, hot: true, label: 'Daily spending limit', description: 'Central stops for the day (UTC) once it has spent this many dollars. 0 = no limit (default). Stored in millionths of a dollar (1,000,000 = $1). Separately, once total spend today passes $10, webterm shows one notice for the day; that notice never stops work.' }),
  flag('WEBTERM_CENTRAL_SKILLS', 'central', { ...C, hot: true, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Let Central use skills', description: 'Central may use the skills you have reviewed and approved.' }),
  flag('WEBTERM_CENTRAL_SKILL_PROPOSE', 'central', { ...C, hot: true, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Suggest new skills', description: 'Central may draft new skills for you to review. A draft is never used until you approve it.' }),
  flag('WEBTERM_CENTRAL_BOTS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }, { key: 'WEBTERM_CHANNELS', oneOf: ['on'] }], label: 'Bot per project', description: 'One bot with a topic per project (needs Telegram and WEBTERM_CHANNELS).' }),
  flag('WEBTERM_CHANNEL_APPROVAL_BUTTONS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }], label: 'Telegram approval buttons', description: 'Approve once / Deny buttons on Telegram approval cards are processed (on by default; needs Telegram). Off ignores button presses; /approve still works.' }, 'on'),
  flag('WEBTERM_KNOWLEDGE', 'central', { ...C, label: 'Project knowledge index', description: 'Central keeps a searchable index of your project files so it can find code faster.' }),
  num('WEBTERM_AGENT_IDLE_DONE_MS', 'central', 1000, 3_600_000, DEFAULT_AGENT_IDLE_DONE_MS, {
    ...C, hot: true,
    unit: 'ms',
    label: 'Idle time before a worker counts as done',
    description: 'A worker that is not Claude Code and has been quiet this long, with file changes, is treated as probably done. In milliseconds.',
  }),
  flag('WEBTERM_CENTRAL_RELIABILITY', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL_AUTONOMY' }], label: 'Reliable autonomy', description: 'When Central works on its own, it runs several workers side by side and stops retrying a task that keeps failing (needs autonomy).' }),
  num('WEBTERM_CENTRAL_MAX_INFLIGHT', 'central', 1, 100, DEFAULT_MAX_INFLIGHT, { ...C, unit: 'workers', label: 'Workers at once', description: 'How many workers Central may run at the same time when it works on its own. Applies after a restart.' }),
  flag('WEBTERM_AGENT_MAIL', 'central', { ...C, requires: [AGENTS_ON], label: 'Messages to workers', description: 'Central may send messages to workers it started (needs the Worker orchestrator).' }),
  flag('WEBTERM_CENTRAL_READ_TOOLS', 'central', { ...C, hot: true, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Let Central look at projects', description: 'Central may read your projects, nodes and tasks. Follows the Central Agent switch.' }),
  num('WEBTERM_CENTRAL_CONTEXT_WINDOW', 'central-context', 1000, MAX_NUMBER, DEFAULT_CONTEXT_WINDOW, { ...C, hot: true, unit: 'tokens', label: 'Context window size', description: 'How much the model can hold at once. Central starts a fresh session at 70%, carrying over a summary. Applies from the next reply.' }),
  num('WEBTERM_CENTRAL_TURN_STEPS', 'central-turn', 1, 100, DEFAULT_TURN_STEPS, { ...C, hot: true, unit: 'steps', label: 'Steps per reply', description: 'How many steps (tool calls) Central may take in one reply. Applies from the next reply.' }),
]
