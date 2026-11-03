// Registry env: Central Agent v2 (RND/29-CA2-ARSITEKTUR-b.md 4.7). Data murni; semua flag default off,
// angka = batas aman. Dibaca saat boot (restart wajib) sampai pembacanya terbukti per-panggilan.
import { enumOf, flag, num, text, type EnvSpec } from './envRegistry.types'

const DEFAULT_MAX_STEPS = 2
const DEFAULT_TURN_WALL_MS = 120_000
const DEFAULT_TURN_TOKENS = 60_000
const DEFAULT_DAILY_TOKENS = 1_000_000
const DEFAULT_DAILY_SPAWNS = 20
const DEFAULT_AGENT_IDLE_DONE_MS = 45_000
const MAX_NUMBER = 1_000_000_000

export const CA2_ENV_SPECS: readonly EnvSpec[] = [
  enumOf('WEBTERM_CENTRAL_AGENTS', 'central', ['off', 'propose', 'auto'], 'off', {
    label: 'Agen central',
    description: 'Central boleh menjalankan worker: propose = kartu approval per aksi, auto = dalam amplop. Butuh tools=write, planner, orchestrator run.',
    dangerous: true,
  }),
  flag('WEBTERM_CENTRAL_CHECKPOINT', 'central', { label: 'Checkpoint percakapan', description: 'Ringkas percakapan central ke checkpoint (butuh runtime opencode).' }),
  num('WEBTERM_CENTRAL_MAX_STEPS', 'central', 1, 10, DEFAULT_MAX_STEPS, { label: 'Langkah maks per turn', description: 'Batas langkah tool dalam satu turn central.' }),
  num('WEBTERM_CENTRAL_TURN_WALL_MS', 'central', 1000, 600_000, DEFAULT_TURN_WALL_MS, { label: 'Batas waktu turn (ms)', description: 'Batas dinding waktu satu turn central.' }),
  num('WEBTERM_CENTRAL_TURN_TOKENS', 'central', 1000, MAX_NUMBER, DEFAULT_TURN_TOKENS, { label: 'Batas token turn', description: 'Batas token satu turn central.' }),
  num('WEBTERM_CENTRAL_DAILY_TOKENS', 'central', 0, MAX_NUMBER, DEFAULT_DAILY_TOKENS, { label: 'Budget token harian', description: 'Batas token central per hari UTC; 0 = tanpa batas.' }),
  num('WEBTERM_CENTRAL_DAILY_SPAWNS', 'central', 0, MAX_NUMBER, DEFAULT_DAILY_SPAWNS, { label: 'Budget spawn harian', description: 'Batas worker yang boleh di-spawn central per hari UTC.' }),
  num('WEBTERM_CENTRAL_DAILY_COST_MICROS', 'central', 0, MAX_NUMBER, 0, { label: 'Budget biaya harian (mikro)', description: 'Batas biaya central per hari dalam mikro-unit; 0 = tanpa batas.' }),
  enumOf('WEBTERM_CENTRAL_TOOL_BRIDGE', 'central', ['text', 'opencode'], 'text', { label: 'Jembatan tool', description: 'Cara central memanggil tool: text = parse teks, opencode = tool native opencode.' }),
  flag('WEBTERM_CENTRAL_SKILLS', 'central', { label: 'Skill central', description: 'Central membaca skill dari <dataDir>/central/skills (butuh tools).' }),
  flag('WEBTERM_CENTRAL_SKILL_PROPOSE', 'central', { label: 'Usul skill central', description: 'Central boleh mengusulkan skill baru untuk disetujui manusia (butuh Skill central).' }),
  flag('WEBTERM_CENTRAL_BOTS', 'central', { label: 'Bot per project', description: 'Satu bot dengan topic per project (butuh Telegram dan WEBTERM_CHANNELS).' }),
  flag('WEBTERM_KNOWLEDGE', 'central', { label: 'Knowledge base', description: 'Indeks pengetahuan project di <dataDir>/knowledge.db.' }),
  flag('WEBTERM_KNOWLEDGE_GRAPHIFY', 'central', { label: 'Knowledge via graphify', description: 'Isi knowledge base lewat graphify (butuh graphify di PATH).' }),
  text('WEBTERM_EMBED_URL', 'memory', {
    label: 'URL embedding',
    description: 'Endpoint embedding memori; isi memori dikirim ke sana. Kosong = pencarian leksikal saja.',
    dangerous: true,
  }),
  text('WEBTERM_EMBED_MODEL', 'memory', { label: 'Model embedding', description: 'Model untuk endpoint embedding.' }),
  num('WEBTERM_AGENT_IDLE_DONE_MS', 'central', 1000, 3_600_000, DEFAULT_AGENT_IDLE_DONE_MS, {
    label: 'Idle = kandidat selesai (ms)',
    description: 'Worker non-claude yang diam selama ini dengan diff tak kosong dianggap kandidat selesai.',
  }),
]
