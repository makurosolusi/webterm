import { agentConfig, type AgentId, type BuiltinAgentId } from './workspace.agents'

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

// Claude-first: only Claude Code is a first-class harness, so every list holds `claude` alone. A
// custom agent with `baseAgent: 'claude'` inherits all of them through `capabilityAgentId`.

/** Agent yang bisa melanjutkan percakapan lewat session id. */
export const RESUMABLE_AGENTS = ['claude'] as const

// Agent yang session id-nya KITA cetak saat peluncuran (`--session-id <uuid>`) alih-alih hanya
// dipelajari dari event hook. Minting menjamin sebuah node selalu punya SEBUAH id yang bisa
// di-resume, sehingga kasus terburuk turun dari "percakapan hilang" menjadi "kontinuitas sejak
// /clear terakhir hilang".
export const SESSION_ID_CAPABLE = ['claude'] as const

// Agent yang bisa membaca konteks node tertaut (skill `get-linked-context` di ~/.claude/skills).
export const CONTEXT_LINK_CAPABLE = ['claude'] as const

// Agent yang meter konteks per-node-nya bisa kita isi. Tiap anggota butuh DUA angka: jumlah
// terpakai dan window yang bisa dipercaya.
export const USAGE_CAPABLE = ['claude'] as const

// Agent yang harness-nya menerima mode permission saat peluncuran.
export const PERMISSION_MODE_CAPABLE = ['claude'] as const

// Agent yang harness-nya menerima override model per-peluncuran.
export const MODEL_SWITCH_CAPABLE = ['claude'] as const

// Agent yang menerima konfigurasi hook webterm INLINE di baris peluncuran, lewat flag `--settings`
// milik Claude Code (lihat `claudeHooksSettings` di src/server/hooks.ts). Itu grammar claude: tidak
// ada harness lain yang mengerti flag maupun bentuk JSON-nya.
//
// Agent baru boleh masuk hanya bila harness-nya benar-benar menerima `--settings` claude; CLI lain
// yang diluncurkan dengan flag itu mati di peluncuran.
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
 *  `--permission-mode`. `manual` dikirim sebagai `--permission-mode default`. */
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
