// Satu-satunya sumber kebenaran untuk identitas agent, kapabilitas harness, dan bentuk workspace
// yang dipersist. Hanya field dan
// kapabilitas yang punya konsumen nyata di webterm.

// ---------------------------------------------------------------------------------------------
// Identitas agent

// Claude-first: Claude Code is the only builtin harness. Other CLIs (codex, gemini, opencode, …)
// are plain terminal programs now — a stored node with such an `agentId` still launches its `cmd`
// untouched, it just resolves like a custom agent without capabilities (`agentConfig` → undefined).
export type BuiltinAgentId = 'claude'

// Tipe TERBUKA. Agent custom adalah string apa pun (konvensi: `custom:<uuid>`; nilai
// warisan webterm `'custom'` tetap valid). JANGAN pernah dipersempit jadi union tertutup —
// begitu ditutup, agent custom dan node warisan (`agentId: 'codex'`) tidak lagi valid.
export type AgentId = BuiltinAgentId | (string & {})

// `failed` = the agent never started or exited non-zero (agent-211-A2); `stopped` = the user ended
// the session with Stop/close and it can be resumed (agent-211-A5). Only the server sets either.
export type AgentStatus = 'working' | 'waiting' | 'blocked' | 'done' | 'failed' | 'stopped'

export interface AgentConfig {
  /** Label menu + judul node, mis. 'Claude Code'. */
  label: string
  /** Warna node (hex). */
  color: string
  /** Perintah peluncuran dasar. */
  launchCmd: string
  /** Nama proses yang diharapkan muncul di `ps` — dipakai deteksi status proses. */
  expectedProcess: string
}

/** Urutan tampil di mana pun agent ditawarkan (menu, Dock, settings). */
export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = ['claude']

export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: { label: 'Claude Code', color: '#d97757', launchCmd: 'claude', expectedProcess: 'claude' },
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
