// Logika murni panel Agent History: node agent untuk Resume dan workspace tujuannya. Dipisah dari
// JSX supaya teruji di vitest node-env (pola `./closedHistory`).
//
// Resume meniru Orca `docs/agents/session-history.mdx` ("opens a new terminal in the session's cwd
// and runs the agent's resume command") tetapi lewat jalur peluncuran node agent yang SUDAH ada,
// bukan baris shell rakitan sendiri:
// node membawa `sessionId` = id transcript Claude. `resumesOnFirstLaunch` (AgentNode) lalu
// meluncurkannya dengan `--resume <id>` plus hook/settings webterm, dan node itu tetap bisa
// di-restart/di-resume di id yang sama sesudahnya.
import { agentConfig, assembleCmd, isSafeSessionId } from '../shared/workspace'
import { resolveClaudeProfileIn } from '../shared/claudeLaunch/claudeLaunch.builtin'
import type { ClaudeLaunchSettings } from '../shared/claudeLaunch/claudeLaunch.profiles'
import type { Workspace } from '../shared/workspace'
import type { PlacedNode } from './closedHistory'
import type { AgentSession } from './SessionHistory.api'

/** Node agent yang melanjutkan `s`, atau `null` bila id-nya tidak aman masuk baris perintah. */
export function resumeNode(s: AgentSession, newId: () => string, claudeProfileId?: string): PlacedNode | null {
  if (!isSafeSessionId(s.id, true)) return null
  // The launch command comes from `claudeProfileId` on the server; `cmd` is the stock line.
  return {
    id: newId(), kind: 'agent', agentId: s.agent, color: agentConfig(s.agent)?.color, ...(s.cwd ? { cwd: s.cwd } : {}),
    cmd: assembleCmd('claude'), sessionId: s.id, ...(claudeProfileId ? { claudeProfileId } : {}),
  }
}

/**
 * Launch profile a resumed claude session gets: that of a board node already on this transcript
 * (any workspace), else the current default profile.
 */
export function resumeProfile(
  s: Pick<AgentSession, 'id'>,
  workspaces: readonly Pick<Workspace, 'nodes'>[],
  settings: Partial<ClaudeLaunchSettings>,
): string {
  for (const w of workspaces) {
    const n = w.nodes?.find((x) => x.agentId === 'claude' && x.sessionId === s.id && x.claudeProfileId)
    if (n?.claudeProfileId) return n.claudeProfileId
  }
  return resolveClaudeProfileIn(settings).profile.id
}

const norm = (p: string): string => p.replace(/\/+$/, '')
const within = (dir: string, cwd: string): boolean => cwd === dir || cwd.startsWith(`${dir}/`)

/**
 * Workspace tempat sesi dilanjutkan: workspace aktif bila cwd sesi ada di dalamnya, selain itu
 * workspace dengan cwd TERDALAM yang memuat cwd sesi, selain itu workspace aktif (node membawa cwd
 * sesinya sendiri, jadi CLI tetap berjalan di direktori yang benar).
 */
export function targetWorkspace(
  s: Pick<AgentSession, 'cwd'>,
  workspaces: readonly Pick<Workspace, 'id' | 'cwd'>[],
  activeId: string | null,
): string | null {
  if (!s.cwd) return activeId
  const cwd = norm(s.cwd)
  const active = workspaces.find((w) => w.id === activeId)
  if (active?.cwd && within(norm(active.cwd), cwd)) return active.id
  let best: { id: string; len: number } | null = null
  for (const w of workspaces) {
    if (!w.cwd) continue
    const dir = norm(w.cwd)
    if (within(dir, cwd) && (!best || dir.length > best.len)) best = { id: w.id, len: dir.length }
  }
  return best?.id ?? activeId
}

/** "5m ago" / "3h ago" / "2d ago" / tanggal. Bahasa Inggris (teks produk). */
export function relativeTime(at: number | null, now = Date.now()): string {
  if (at === null) return ''
  const m = Math.round((now - at) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString()
}
