// Satu-satunya sumber kebenaran untuk identitas agent, kapabilitas harness, dan bentuk workspace
// yang dipersist. Porting ramping dari nodeterm `src/shared/agents/config.ts` — hanya field dan
// kapabilitas yang punya konsumen nyata di webterm.

// ---------------------------------------------------------------------------------------------
// Identitas agent

export type BuiltinAgentId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'grok'
  | 'copilot'
  | 'antigravity'
  | 'cursor'

// Tipe TERBUKA. Agent custom adalah string apa pun (konvensi nodeterm: `custom:<uuid>`; nilai
// warisan webterm `'custom'` tetap valid). JANGAN pernah dipersempit jadi union tertutup —
// begitu ditutup, agent custom tidak bisa lagi menunjuk base harness.
export type AgentId = BuiltinAgentId | (string & {})

export type AgentStatus = 'working' | 'waiting' | 'blocked' | 'done'

export interface AgentConfig {
  /** Label menu + judul node, mis. 'Claude Code'. */
  label: string
  /** Warna node (hex). */
  color: string
  /** Perintah peluncuran dasar. */
  launchCmd: string
  /** Nama proses yang diharapkan muncul di `ps` — dipakai deteksi status proses. */
  expectedProcess: string
  /**
   * Peringatan satu kalimat untuk tooltip di tempat agent DITAWARKAN. Bukan kapabilitas, jangan
   * pernah dibaca untuk memutuskan perilaku. Ada demi gemini: Google berhenti melayani Gemini CLI
   * ke akun personal pada 2026-06-18, dan pengguna akun personal yang memilihnya hanya menemui
   * loop sign-in tanpa penjelasan.
   */
  notice?: string
}

// Urutan tampil di mana pun agent ditawarkan (menu, Dock, settings). antigravity di atas gemini:
// sejak 2026-06-18 ia agent Google untuk akun personal, gemini tersisa untuk Code Assist/Vertex.
export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = [
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'opencode',
  'grok',
  'copilot',
  'cursor',
]

// Nilai dibaca langsung dari nodeterm v0.4.5 `src/shared/agents/config.ts` (hasil pengukuran
// terhadap binary yang terpasang di sana) — bukan karangan.
export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: { label: 'Claude Code', color: '#d97757', launchCmd: 'claude', expectedProcess: 'claude' },
  codex: { label: 'Codex', color: '#10a37f', launchCmd: 'codex', expectedProcess: 'codex' },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    launchCmd: 'gemini',
    expectedProcess: 'gemini',
    notice:
      'Google stopped serving Gemini CLI to personal accounts (free, AI Pro, AI Ultra) on 2026-06-18 — use Antigravity instead. Code Assist Standard/Enterprise, Vertex AI and paid API keys still work.',
  },
  opencode: { label: 'opencode', color: '#a78bfa', launchCmd: 'opencode', expectedProcess: 'opencode' },
  grok: { label: 'Grok', color: '#64748b', launchCmd: 'grok', expectedProcess: 'grok' },
  copilot: { label: 'GitHub Copilot', color: '#8957e5', launchCmd: 'copilot', expectedProcess: 'copilot' },
  // CLI Google Antigravity. Binary-nya `agy`, bukan `antigravity`.
  antigravity: { label: 'Antigravity', color: '#00a3a3', launchCmd: 'agy', expectedProcess: 'agy' },
  // Bukan `agent`: CLI memasang alias itu juga, dan grok mengirim binary bernama sama. Wrapper
  // menjalankan `exec -a "$0" node index.js`, jadi ps menampilkan argv0 `cursor-agent`.
  cursor: { label: 'Cursor', color: '#d9468f', launchCmd: 'cursor-agent', expectedProcess: 'cursor-agent' },
}

/** Alias warisan; konsumen baru sebaiknya pakai `AGENT_CONFIG` atau `agentConfig(id)`. */
export const AGENTS = AGENT_CONFIG

/** Warna fallback untuk agent custom/tak dikenal yang tidak membawa warna sendiri. */
export const FALLBACK_AGENT_COLOR = '#888888'

/** Config builtin untuk sebuah id, atau undefined untuk agent custom/tak dikenal. */
export const agentConfig = (id: AgentId): AgentConfig | undefined =>
  (AGENT_CONFIG as Record<string, AgentConfig>)[id]

/** Mempersempit `AgentId` yang terbuka menjadi `BuiltinAgentId`. Dipakai di call-site yang hanya
 *  punya grammar untuk builtin (mis. `assembleCmd`), supaya penyempitannya diperiksa compiler
 *  alih-alih dipaksa dengan `as`. */
export const isBuiltinAgent = (id: AgentId): id is BuiltinAgentId => !!agentConfig(id)

// ---------------------------------------------------------------------------------------------
// Pewarisan harness untuk agent custom.
//
// Agent custom boleh mendeklarasikan `baseAgent` (salah satu builtin) untuk MEWARISI kapabilitas
// harness itu — resume, context link, permission mode, minting session id. Kasus pakainya: CLI
// yang kompatibel harness (mis. wrapper claude yang menunjuk proxy inferensi sendiri) di mana
// integrasi webterm ingin dipertahankan sementara panggilannya dialihkan. Tanpa ini, agent custom
// tidak punya kapabilitas APA PUN.
//
// Predikat kapabilitas di bawah hanya menerima `AgentId`. Modul ini tidak boleh mengimpor
// `settings.ts` (settings mengimpor AgentId dari sini → siklus), jadi lookup custom-id → baseAgent
// DIINJEKSIKAN: tiap runtime (client & server) mendaftarkan resolver sekali saat init yang membaca
// store settings-nya sendiri.
type BaseResolver = (id: AgentId) => BuiltinAgentId | undefined
let customBaseResolver: BaseResolver | null = null

/** Daftarkan resolver custom-id → baseAgent. Dipanggil sekali saat init oleh client dan server.
 *  Kirim `null` untuk membersihkan (dipakai test). */
export function setCustomAgentBaseResolver(fn: BaseResolver | null): void {
  customBaseResolver = fn
}

/** Harness builtin yang diwarisi sebuah agent custom, atau `undefined` untuk builtin dan untuk
 *  agent custom tanpa `baseAgent`. Builtin tidak pernah lewat registry — mereka MEMANG harness-nya
 *  — sehingga agent custom yang id-nya kebetulan bertabrakan dengan nama builtin tetap resolve
 *  sebagai builtin itu, bukan sebagai dirinya. */
export function baseAgentOf(id: AgentId): BuiltinAgentId | undefined {
  if (!customBaseResolver) return undefined
  if (agentConfig(id)) return undefined
  return customBaseResolver(id)
}

/** Id yang kapabilitasnya berlaku untuk `id`: base harness bila agent custom mewarisi, selain itu
 *  `id` sendiri. Semua predikat kapabilitas resolve lewat ini, jadi pewarisan otomatis berlaku di
 *  mana pun predikat dipanggil — tanpa plumbing per call-site. */
export function capabilityAgentId(id: AgentId): AgentId {
  return baseAgentOf(id) ?? id
}

const includes = (list: readonly string[], id: AgentId): boolean =>
  list.includes(capabilityAgentId(id))

// ---------------------------------------------------------------------------------------------
// Kapabilitas = daftar keanggotaan builtin. Satu daftar per kapabilitas, bukan objek kapabilitas:
// CLI berikutnya yang menumbuhkan kemampuan bergabung dengan ditambahkan ke daftar, tidak ada
// yang lain berubah.

/** Agent yang bisa melanjutkan percakapan lewat session id. */
export const RESUMABLE_AGENTS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'copilot',
  'antigravity',
  'cursor',
] as const

// Agent yang session id-nya KITA cetak saat peluncuran (`--session-id <uuid>`) alih-alih hanya
// dipelajari dari event hook. Minting menjamin sebuah node selalu punya SEBUAH id yang bisa
// di-resume, sehingga kasus terburuk turun dari "percakapan hilang" menjadi "kontinuitas sejak
// /clear terakhir hilang".
//
// CATATAN (beda dari nodeterm): nodeterm menggerbangi claude dan grok di balik probe versi CLI
// masing-masing (`supportsSessionIdFlag`). webterm tidak memprobe CLI sama sekali, jadi daftar ini
// dipakai apa adanya. Risikonya terbatas: CLI yang tidak mengenal flag akan menolak di peluncuran
// pertama, bukan merusak data. Kalau itu muncul di lapangan, tambahkan probe — jangan diam-diam
// mengecilkan daftar.
export const SESSION_ID_CAPABLE = ['claude', 'copilot', 'grok', 'cursor'] as const

// Agent yang bisa membaca konteks node tertaut (skill `get-linked-context` di ~/.claude/skills).
// copilot TIDAK termasuk — ia tidak memindai direktori skill Claude.
export const CONTEXT_LINK_CAPABLE = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'cursor',
  'antigravity',
] as const

// Agent yang meter konteks per-node-nya bisa kita isi. Tiap anggota butuh DUA angka: jumlah
// terpakai dan window yang bisa dipercaya.
export const USAGE_CAPABLE = ['claude', 'codex', 'gemini', 'grok', 'cursor', 'antigravity'] as const

// Agent yang harness-nya menerima mode permission saat peluncuran.
export const PERMISSION_MODE_CAPABLE = [
  'claude',
  'grok',
  'gemini',
  'codex',
  'cursor',
  'antigravity',
] as const

// Agent yang harness-nya menerima override model per-peluncuran.
export const MODEL_SWITCH_CAPABLE = [
  'claude',
  'codex',
  'copilot',
  'grok',
  'cursor',
  'antigravity',
] as const

// Agent yang menerima konfigurasi hook webterm INLINE di baris peluncuran, lewat flag `--settings`
// milik Claude Code (lihat `claudeHooksSettings` di src/server/hooks.ts). Itu grammar claude: tidak
// ada harness lain yang mengerti flag maupun bentuk JSON-nya.
//
// SENGAJA LEBIH SEMPIT dari nodeterm. `AGENT_HOOK_TARGETS` nodeterm v0.4.5 memuat kedelapan builtin
// (diverifikasi), tapi di sana hook dipasang lewat installer PER AGENT di luar baris perintah —
// bukan lewat `--settings`. Jadi JANGAN melebarkan daftar ini untuk "menyamai nodeterm": begitu
// codex/gemini/grok masuk, mereka diluncurkan dengan flag claude yang tidak mereka kenal dan node
// mereka mati di peluncuran. Agent baru boleh masuk hanya bila harness-nya benar-benar menerima
// `--settings` claude; kalau hook-nya butuh jalur lain, ia butuh daftarnya sendiri.
export const CLAUDE_HOOK_SETTINGS_CAPABLE = ['claude'] as const

export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const mintsSessionId = (id: AgentId): boolean => includes(SESSION_ID_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => includes(PERMISSION_MODE_CAPABLE, id)
export const canSwitchModel = (id: AgentId): boolean => includes(MODEL_SWITCH_CAPABLE, id)
/** Apakah baris peluncuran `id` membawa konfigurasi hook lewat `--settings` claude? Sadar-pewarisan,
 *  jadi agent custom ber-`baseAgent: 'claude'` ikut mendapat hook. */
export const hasClaudeHookSettings = (id: AgentId): boolean =>
  includes(CLAUDE_HOOK_SETTINGS_CAPABLE, id)

/** Mode permission yang dipakai sesi agent saat START. Pengguna masih bisa memutar mode saat
 *  runtime dengan Shift+Tab — ini hanya menentukan keadaan awal, persis seperti flag
 *  `--permission-mode`. `manual` = tidak ada flag yang dikirim. */
export type AgentPermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

const PERMISSION_MODES: readonly AgentPermissionMode[] = [
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

/** Validasi ulang di titik pemakaian: nilainya mendarat di baris perintah shell, dan tipe hanya
 *  janji compile-time. Settings bisa diedit tangan / datang lewat HTTP. */
export const isPermissionMode = (v: unknown): v is AgentPermissionMode =>
  typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)

// ---------------------------------------------------------------------------------------------
// Validasi session id.
//
// Session id DIINTERPOLASIKAN ke baris perintah shell (`--resume <id>`), jadi setiap titik
// interpolasi memvalidasi ulang terhadap alfabet ini — bukan percaya tipe. Alfabet: alfanumerik di
// depan, lalu `[A-Za-z0-9._-]`. Mencakup setiap id yang dicetak CLI agent (UUID, thread id
// codex/grok) dan menolak nilai mirip-flag (`-x`), berawalan titik, atau bermuatan metakarakter.
export const SESSION_ID_MAX = 256
/** Bentuk terbatas panjang — untuk pemeriksaan di batas input (intent peluncuran, seed identitas). */
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
/** Tanpa batas panjang — dipakai helper resume/minted-id, supaya id panjang yang hari ini berfungsi
 *  tidak diam-diam berhenti bisa di-resume. */
export const SAFE_SESSION_ID_UNBOUNDED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Apakah `s` session id yang aman diinterpolasikan ke baris perintah? `bounded` memberlakukan
 *  `SESSION_ID_MAX` (pakai di batas input; helper resume memanggilnya tanpa batas). */
export function isSafeSessionId(s: unknown, bounded = false): boolean {
  if (typeof s !== 'string') return false
  const sid = s.trim()
  if (!sid) return false
  return (bounded ? SAFE_SESSION_ID : SAFE_SESSION_ID_UNBOUNDED).test(sid)
}

// ---------------------------------------------------------------------------------------------
// Validasi node id.
//
// Node id datang dari client lewat WebSocket dan DIDARATKAN di dua tempat yang mengeksekusi teks:
// baris perintah curl hook claude (`claudeHooksSettings`, src/server/hooks.ts) dan kunci PTY/status.
// Alfabetnya sengaja lebih sempit dari session id: alfanumerik, `_`, `-`, dan `:` — UUID
// `randomId()` muat, dan begitu pula id pane split `${nodeId}:p${n}` dari client/paneTree.ts
// (tanpa `:` setiap pane hasil split ditolak dan tidak pernah mendapat PTY). Karakter pertama WAJIB
// alfanumerik supaya nilai mirip-flag (`-x`, `--help`) ditolak, bukan diteruskan ke shell. Kutip,
// `$`, `;`, spasi, newline, `/`, dan `.` tetap tidak muat. Maksimum 64 karakter.
export const NODE_ID_MAX = 64
export const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

/** Apakah `id` node id yang aman dipakai sebagai kunci sesi DAN diinterpolasikan ke perintah shell?
 *  Dipanggil di batas WebSocket (`Sessions.open`) dan lagi di titik interpolasi (hooks.ts), bukan
 *  dipercaya dari tipe. Menerima id pane split `${nodeId}:p${n}` selama totalnya <= `NODE_ID_MAX`
 *  dan karakter pertamanya alfanumerik (jadi `-x`/`--help` ditolak). */
export const isSafeNodeId = (id: unknown): id is string =>
  typeof id === 'string' && SAFE_NODE_ID.test(id)

// ---------------------------------------------------------------------------------------------
// Grammar peluncuran & resume.

/**
 * Menempelkan flag session-id yang dicetak sendiri ke perintah PELUNCURAN PERTAMA, untuk agent di
 * `SESSION_ID_CAPABLE`. Selain itu — agent lain, id kosong atau tidak aman — mengembalikan `cmd`
 * apa adanya, jadi baris perintah yang tidak berhak membawa flag tetap identik byte demi byte.
 *
 * PELUNCURAN PERTAMA SAJA. `claude --session-id <uuid>` menolak id yang sudah ada ("Session ID …
 * is already in use."), jadi peluncuran ulang node yang sama harus resume — itu tugas
 * `resumeCommand`, dan dua bentuk ini tidak bisa dilipat jadi satu perintah idempoten.
 */
export function withSessionId(cmd: string, id: AgentId, sessionId: string): string {
  if (!mintsSessionId(id)) return cmd
  if (!isSafeSessionId(sessionId)) return cmd
  const sid = sessionId.trim()
  const base = capabilityAgentId(id)
  if (base === 'copilot') return `${cmd} --session-id=${sid}`
  // cursor tidak punya flag session-id: `--resume <uuid> yang belum ada` membuka chat kosong yang
  // MENGADOPSI id itu. Ia root option, jadi letaknya sebelum subcommand.
  if (base === 'cursor') return `${cmd} --resume ${sid}`
  return `${cmd} --session-id ${sid}`
}

/**
 * Resume berdasarkan session id provider, memakai `launchCmd` sebagai binary dan `grammarId` untuk
 * memilih grammar flag resume. `grammarId` adalah BASE harness untuk agent custom yang mewarisi
 * (`capabilityAgentId(agentId)`), sehingga agent custom berbasis claude resume sebagai
 * `<customLaunchCmd> --resume <sid>` — binary-nya sendiri, flag claude. Mengembalikan null untuk
 * base yang tidak resumable atau session id kosong/tidak aman.
 */
export function resumeCommandWith(
  launchCmd: string,
  grammarId: AgentId,
  sessionId: string
): string | null {
  if (!canResume(grammarId)) return null
  if (!isSafeSessionId(sessionId)) return null
  const sid = sessionId.trim()
  switch (capabilityAgentId(grammarId)) {
    case 'codex':
      return `${launchCmd} resume ${sid}`
    case 'opencode':
      return `${launchCmd} --session ${sid}`
    case 'copilot':
      return `${launchCmd} --resume=${sid}`
    case 'antigravity':
      return `${launchCmd} --conversation=${sid}`
    case 'claude':
    case 'gemini':
    case 'grok':
    case 'cursor':
      return `${launchCmd} --resume ${sid}`
    default:
      return null
  }
}

/**
 * Perintah yang me-resume percakapan sebelumnya sebuah agent resumable. Dipakai pada restart
 * dingin, di mana sesi dan agent-nya sudah hilang sehingga percakapan harus direkonstruksi lewat
 * `--resume` milik CLI agent itu sendiri.
 *
 * `base` adalah override perintah peluncuran milik pengguna (`settings.agentLaunchCommands`,
 * mis. wrapper pemilih akun) — DIKIRIMKAN, bukan dibaca di sini: modul ini tidak boleh menjangkau
 * store settings. Bila diisi (tidak kosong) ia mengganti bagian program secara utuh.
 */
export function resumeCommand(id: AgentId, sessionId: string, base?: string): string | null {
  const program = base?.trim() || agentConfig(capabilityAgentId(id))?.launchCmd
  if (!program) return null
  return resumeCommandWith(program, id, sessionId)
}

/** Apakah `sessionId` akan dipasang ke baris `--resume` untuk `id`? Gerbang kelayakan untuk
 *  koreografi restart TANPA membangun perintahnya (yang untuk agent custom butuh `launchCmd` dari
 *  settings, tidak tersedia di sini). Sadar-pewarisan lewat `canResume`. */
export function canResumeWith(id: AgentId, sessionId: string): boolean {
  return canResume(id) && isSafeSessionId(sessionId)
}

/**
 * Bangun baris perintah peluncuran agent: override milik pengguna bila ada
 * (`settings.agentLaunchCommands[agentId]`, mis. skrip pemilih akun), selain itu `launchCmd`
 * builtin. `base` DIKIRIMKAN, bukan dibaca di sini — modul ini tidak boleh menjangkau store
 * settings, persis seperti parameter `base` di `resumeCommand`.
 *
 * Perintah ini nantinya dijalankan via login shell, jadi string biasa sudah benar — JANGAN
 * dipecah jadi argv lebih dulu.
 *
 * TIDAK ADA pembungkus yang dihasilkan di sini. nodeterm tidak pernah membungkus perintah agent
 * (nol kemunculan wrapper semacam itu di source v0.4.5); pemilihan akun/profil adalah urusan
 * override di atas, yang dikarang pengguna sendiri sehingga binary-nya pasti ada di mesinnya.
 */
export function assembleCmd(agentId: BuiltinAgentId, base?: string): string {
  return base?.trim() || AGENT_CONFIG[agentId].launchCmd
}

// ---------------------------------------------------------------------------------------------
// Bentuk workspace yang dipersist.

export interface Viewport { x: number; y: number; zoom: number }

export interface Comment {
  id: string
  text: string
  ts: number          // epoch ms
  author?: string
}

export interface BridgeLink {
  id: string
  source: string      // node id asal link (link-out)
  target: string      // node id tujuan link (link-in / pembaca)
  /** 'context' = link antar agent yang digambar pengguna lewat handle. 'file' = penanda "file ini
   *  sedang terbuka" dari node files ke node editor-nya, dibuat otomatis (bukan lewat onConnect).
   *  Dibedakan karena labelnya beda: melabeli kabel buka-file "⇄ context" adalah label bohong. */
  kind: 'context' | 'file'
}

export type WsNodeKind = 'terminal' | 'agent' | 'files' | 'editor'

/** Satu pane = satu PTY. `id` adalah id sesi yang dipakai protokol, jadi daun akar sebuah node
 *  memakai id NODE-nya sendiri: board yang tersimpan sebelum split ada tetap menemukan shell-nya. */
export interface PaneLeaf { id: string }

/** Pembagian dua sebuah ruang. `dir: 'h'` = anak BERDAMPINGAN (`a` kiri, `b` kanan), pembatasnya
 *  tegak dan digeser di sumbu X. `dir: 'v'` = anak BERTUMPUK (`a` atas, `b` bawah). `ratio` adalah
 *  porsi untuk `a`, 0..1. Operasinya di `client/paneTree.ts`. */
export interface PaneSplit { dir: 'h' | 'v'; ratio: number; a: Pane; b: Pane }

/** Pohon pane sebuah node terminal. REKURSIF, bukan daftar datar: susunan 2×2 adalah split di
 *  dalam split, dan daftar datar tidak bisa menyatakan sisi mana yang terbagi. */
export type Pane = PaneLeaf | PaneSplit

/** Opsi tampilan node 'files' yang dipersist per node (P-15). Absen = default (hidden tampil, nama naik). */
export interface ViewOpts { hidden: boolean; sortKey: 'name' | 'size' | 'mtime'; sortDir: 'asc' | 'desc' }

// CATATAN PERSISTENSI: `WsNode` dipersist sebagai satu blob JSON di satu kolom SQLite
// (`src/server/db.ts`), jadi menambah kind atau field di sini adalah NOL migration.
export interface WsNode {
  id: string
  kind: WsNodeKind
  x: number
  y: number
  width?: number          // ukuran di canvas; default diterapkan di store.toFlow
  height?: number         // ukuran di canvas; default diterapkan di store.toFlow
  title?: string
  cwd?: string            // jatuh ke cwd workspace bila tidak ada
  cmd?: string            // baris peluncuran agent, mis. "claude" atau override milik pengguna
  agentId?: AgentId
  color?: string
  sessionId?: string      // UUID dicetak saat peluncuran; memungkinkan resume
  collapsed?: boolean     // chrome node diringkas jadi header saja
  hideLinks?: boolean     // edge context disembunyikan dari node ini
  comments?: Comment[]    // thread aktivitas/catatan per node
  dirPath?: string        // node 'files': direktori akar yang ditampilkan
  filePath?: string       // node 'editor': file yang dibuka
  viewOpts?: ViewOpts     // node 'files': opsi tampilan (hidden/sort); absen = default
  panes?: Pane            // node 'terminal': pohon split pane; absen = satu terminal ber-id node
}

export interface Workspace {
  id: string
  name: string
  cwd?: string
  color?: string
  viewport: Viewport
  nodes: WsNode[]
  bridges: BridgeLink[]   // edge context-link antar node
  updatedAt: number
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

/** Node context-capable iff ia node agent yang harness-nya bisa membaca konteks tertaut. Menerima
 *  `undefined` (terminal biasa) sebagai false. Sadar-pewarisan lewat `canContextLink`. */
export function isContextCapable(agentId?: AgentId): boolean {
  return !!agentId && canContextLink(agentId)
}

/** Kedua ujung context-capable → link 'context' boleh terbentuk; selain itu tidak ada link. */
export function classifyLink(a?: AgentId, b?: AgentId): 'context' | null {
  return isContextCapable(a) && isContextCapable(b) ? 'context' : null
}
