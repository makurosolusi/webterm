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
