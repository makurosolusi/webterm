// Registry env: Central Agent v2 (RND/29-CA2-ARSITEKTUR-b.md 4.7). Data murni; semua flag default off,
// angka = batas aman. `hot` hanya untuk kunci yang pembacanya membaca process.env tiap panggilan (bukti: HOT_PROOF
// di envRegistry.parity.test.ts); sisanya boot. Rentang angka di sini batas konservatif UI, bukan batas pembaca.
import { enumOf, flag, num, text, type EnvSpec } from './envRegistry.types'

const DEFAULT_MAX_STEPS = 2
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
// EMBED_*: pencarian memori, jadi section Memori (bersama WEBTERM_MEMORY_*).
const MEM = { owner: 'platform', section: 'Memori', audience: 'advanced' } as const
const AGENTS_ON = { key: 'WEBTERM_CENTRAL_AGENTS', oneOf: ['propose', 'auto'], note: 'Butuh Agen central propose atau auto.' }
const RUNTIME_OPENCODE = { key: 'WEBTERM_CENTRAL_RUNTIME', oneOf: ['opencode'], note: 'Butuh runtime opencode.' }

export const CA2_ENV_SPECS: readonly EnvSpec[] = [
  enumOf('WEBTERM_CENTRAL_AGENTS', 'central', ['off', 'propose', 'auto'], 'off', {
    ...C, dangerNote: 'Central dapat menjalankan worker nyata (shell, edit file) di mesin server; auto tanpa kartu approval per aksi.', requires: [{ key: 'WEBTERM_CENTRAL_TOOLS', oneOf: ['write'] }, { key: 'WEBTERM_CENTRAL_PLANNER' }, { key: 'WEBTERM_ORCHESTRATOR_RUN' }],
    label: 'Agen central',
    description: 'Central boleh menjalankan worker: propose = kartu approval per aksi, auto = dalam amplop. Butuh tools=write, planner, orchestrator run.',
    dangerous: true,
  }),
  flag('WEBTERM_CENTRAL_CHECKPOINT', 'central-context', { ...C, requires: [RUNTIME_OPENCODE], label: 'Checkpoint percakapan', description: 'Ringkas percakapan central ke checkpoint (butuh runtime opencode).' }),
  num('WEBTERM_CENTRAL_MAX_STEPS', 'central-turn', 1, 10, DEFAULT_MAX_STEPS, { ...C, hot: true, label: 'Langkah tool maks per turn', description: 'Batas putaran tool dalam satu turn central (1-10); dibaca ulang tiap turn.' }),
  num('WEBTERM_CENTRAL_TURN_WALL_MS', 'central-turn', 1000, 600_000, DEFAULT_TURN_WALL_MS, { ...C, hot: true, label: 'Batas waktu turn (ms)', description: 'Batas waktu satu turn central; dibaca ulang tiap turn. Rentang 1.000-600.000 ms adalah batas konservatif Pengaturan.' }),
  num('WEBTERM_CENTRAL_TURN_TOKENS', 'central-turn', 1000, MAX_NUMBER, DEFAULT_TURN_TOKENS, { ...C, label: 'Batas token turn', description: 'Dicatat; belum diberlakukan runtime produksi.' }),
  num('WEBTERM_CENTRAL_DAILY_TOKENS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_TOKENS, { ...C, hot: true, label: 'Budget token harian', description: 'Batas token central per hari UTC; 0 = tanpa batas. Berlaku pada pemeriksaan berikutnya.' }),
  num('WEBTERM_CENTRAL_DAILY_SPAWNS', 'central-budget', 0, MAX_NUMBER, DEFAULT_DAILY_SPAWNS, { ...C, hot: true, label: 'Budget spawn harian', description: 'Batas worker yang boleh di-spawn central per hari UTC; 0 = tidak boleh spawn. Berlaku pada pemeriksaan berikutnya.' }),
  num('WEBTERM_CENTRAL_DAILY_COST_MICROS', 'central-budget', 0, MAX_NUMBER, 0, { ...C, hot: true, label: 'Budget biaya harian (mikro)', description: 'Batas biaya central per hari dalam mikro-unit; 0 = tanpa batas. Berlaku pada pemeriksaan berikutnya.' }),
  enumOf('WEBTERM_CENTRAL_TOOL_BRIDGE', 'central-lab', ['text', 'opencode'], 'text', { ...C, stage: 'experimental', label: 'Jembatan tool', description: 'Belum dipakai server. Rencana: text = parse teks, opencode = tool native opencode.' }),
  flag('WEBTERM_CENTRAL_SKILLS', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Skill central', description: 'Central membaca skill dari <dataDir>/central/skills (butuh tools).' }),
  flag('WEBTERM_CENTRAL_SKILL_PROPOSE', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL_SKILLS' }], label: 'Usul skill central', description: 'Central boleh mengusulkan skill baru untuk disetujui manusia (butuh Skill central).' }),
  flag('WEBTERM_CENTRAL_BOTS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }, { key: 'WEBTERM_CHANNELS', oneOf: ['on'] }], label: 'Bot per project', description: 'Satu bot dengan topic per project (butuh Telegram dan WEBTERM_CHANNELS).' }),
  flag('WEBTERM_CHANNEL_APPROVAL_BUTTONS', 'telegram', { ...TGC, requires: [{ key: 'WEBTERM_TELEGRAM' }, { key: 'WEBTERM_LEDGER', oneOf: ['on', 'shadow'] }], label: 'Tombol approval Telegram', description: 'Tombol setuju/tolak pada kartu approval Telegram diproses (butuh Telegram dan ledger).' }),
  flag('WEBTERM_KNOWLEDGE', 'central', { ...C, label: 'Knowledge base', description: 'Indeks pengetahuan project di <dataDir>/knowledge.db.' }),
  flag('WEBTERM_KNOWLEDGE_GRAPHIFY', 'central-lab', { ...C, stage: 'experimental', requires: [{ key: 'WEBTERM_KNOWLEDGE' }], label: 'Knowledge via graphify', description: 'Belum dipakai server. Rencana: isi knowledge base lewat graphify (butuh graphify di PATH).' }),
  text('WEBTERM_EMBED_URL', 'memory', {
    ...MEM, stage: 'experimental', allowEmpty: true, dangerNote: 'Isi memori dikirim ke endpoint ini; isi hanya host yang kamu percaya.',
    label: 'URL embedding',
    description: 'Belum dipakai server (pencarian memori masih leksikal). Rencana: endpoint embedding; isi memori dikirim ke sana.',
    dangerous: true,
  }),
  text('WEBTERM_EMBED_MODEL', 'memory', { ...MEM, stage: 'experimental', allowEmpty: true, label: 'Model embedding', description: 'Belum dipakai server. Rencana: model untuk endpoint embedding.' }),
  num('WEBTERM_AGENT_IDLE_DONE_MS', 'central', 1000, 3_600_000, DEFAULT_AGENT_IDLE_DONE_MS, {
    ...C, hot: true,
    label: 'Idle = kandidat selesai (ms)',
    description: 'Worker non-claude yang diam selama ini dengan diff tak kosong dianggap kandidat selesai; dibaca ulang tiap pemeriksaan.',
  }),
  flag('WEBTERM_CENTRAL_RELIABILITY', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL_AUTONOMY' }], label: 'Reliabilitas autonomy', description: 'Autonomy memakai dispatcher non-blocking, wake, dan breaker per item (butuh autonomy).' }),
  num('WEBTERM_CENTRAL_MAX_INFLIGHT', 'central', 1, 100, DEFAULT_MAX_INFLIGHT, { ...C, label: 'Worker bersamaan maks', description: 'Batas global worker yang dijalankan autonomy sekaligus (mode reliabilitas). Dibaca saat boot; berlaku setelah restart.' }),
  flag('WEBTERM_AGENT_MAIL', 'central', { ...C, requires: [AGENTS_ON], label: 'Mailbox agen', description: 'Central boleh menitipkan pesan ke worker lewat mailbox (butuh Agen central).' }),
  flag('WEBTERM_CENTRAL_READ_TOOLS', 'central', { ...C, requires: [{ key: 'WEBTERM_CENTRAL' }], label: 'Tool baca central', description: 'Central boleh membaca project, node, dan task lewat tool baca dan melanjutkan turn (butuh tools).' }),
  num('WEBTERM_CENTRAL_CONTEXT_WINDOW', 'central-context', 1000, MAX_NUMBER, DEFAULT_CONTEXT_WINDOW, { ...C, hot: true, label: 'Jendela konteks (token)', description: 'Ukuran jendela model untuk rotasi sesi (70%) dan penolakan turn (85%); dibaca ulang tiap turn.' }),
  num('WEBTERM_CENTRAL_TURN_STEPS', 'central-turn', 1, 100, DEFAULT_TURN_STEPS, { ...C, hot: true, label: 'Giliran maks per turn', description: 'Batas giliran runtime dalam satu turn central; dibaca ulang tiap turn. Rentang 1-100 adalah batas konservatif Pengaturan.' }),
]
