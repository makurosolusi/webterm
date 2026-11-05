// AI name-gen: pure clip/prompt/clean helpers up top (unit-testable, node-env),
// plus one impure entry. generateName lazy-imports ./sessions (mirrors
// contextLink.ts) so the node-env vitest suite never pulls a bun module at load.
// Bun.spawn is typed locally (a narrow slice) because @types/bun reddens
// unrelated files — same reason pty.ts declares its own Bun types.
import { claudeEnv } from './claudeProvider/claudeProvider.store'
import { centralClaudeLaunch, claudeLaunchLine } from './claudeLauncher/claudeLauncher'

export function clipTerminal(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  return trimmed.split('\n').slice(-150).join('\n').slice(-8000)
}

export function buildNamePrompt(clip: string): string {
  return `Below is the recent output of a terminal session. Suggest a very short title (2-4 words, Title Case, no surrounding quotes, no trailing punctuation) describing what this terminal is used for. Output ONLY the title.\n\nTerminal output:\n\`\`\`\n${clip}\n\`\`\``
}

/** Orca-style naming prompt from the first task (`shared/branch-name-from-work.ts:80-99`). */
export function buildTaskNamePrompt(firstPrompt: string): string {
  return `Suggest a very short title (2-5 words, Title Case, no surrounding quotes, no trailing punctuation) that summarizes the task described below. Output ONLY the title.\n\nUser request:\n${firstPrompt.trim().slice(0, 4000)}`
}

// Text that reaches the transcript as a "user" turn but is not the user's task: tool results are
// filtered by shape; webterm/nodeterm notes and Claude's own `<command-…>`/`<local-command-…>`
// wrappers are filtered by prefix.
const NOT_A_TASK = /^(\[webterm\]|\[nodeterm\]|<)/

/** First real user prompt in a claude transcript JSONL, or '' when none yet. */
export function firstPromptFromTranscript(raw: string): string {
  for (const line of raw.split('\n')) {
    let o: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try { o = JSON.parse(line) } catch { continue }
    if (o?.type !== 'user' || o.isMeta) continue
    const c = o.message?.content
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
      : ''
    const t = text.trim()
    if (t && !NOT_A_TASK.test(t)) return t
  }
  return ''
}

/** Deterministic fallback title from a prompt: first line, cut at a word boundary, max 40 chars. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ').replace(/["'`.:;,]+$/g, '').trim()
  if (line.length <= 40) return line
  const cut = line.slice(0, 40)
  const sp = cut.lastIndexOf(' ')
  return (sp > 20 ? cut.slice(0, sp) : cut).trim()
}

export function cleanName(raw: string): string {
  return raw.split('\n')[0].replace(/["'`.]+$/g, '').trim().slice(0, 40)
}

declare const Bun: {
  spawn(cmd: string[], options: { stdin: string; stdout: 'pipe'; cwd?: string; env?: Record<string, string> }): {
    stdout: ReadableStream<Uint8Array>; exited: Promise<number>
  }
}

/** Env of the headless `claude -p`: the server env with the Claude provider (Settings > Capabilities) applied. */
export function cleanEnv(): Record<string, string> {
  return { ...claudeEnv(process.env), TERM: 'xterm-256color' }
}

/** Login-shell line of the naming call: the Central launch profile (e.g. `envman -e p -- claude`) in print mode. */
export const nameGenLine = (): string => `${claudeLaunchLine(centralClaudeLaunch())} -p`

/**
 * Title for a node. The first task in the node's claude transcript wins (what Orca names from on
 * first work, `main/agent-hooks/first-work-branch-rename.ts:123-129`); the terminal buffer is the
 * fallback for agents without a transcript. When the claude CLI fails but a prompt exists, the
 * prompt itself is shortened, so a task-derived title still appears.
 */
export async function generateName(nodeId: string): Promise<{ ok: boolean; message: string }> {
  const { sessions } = await import('./sessions')
  const { readTranscriptFile } = await import('./contextLinkTranscript')
  const path = sessions.getTranscript(nodeId)
  const firstPrompt = path ? firstPromptFromTranscript(readTranscriptFile(path) ?? '') : ''
  const clip = firstPrompt ? '' : clipTerminal(sessions.getTerminal(nodeId))
  if (!firstPrompt && !clip) return { ok: false, message: 'No terminal output to read yet.' }
  const fallback = firstPrompt ? titleFromPrompt(firstPrompt) : ''
  try {
    const shell = process.env.SHELL || 'bash'
    const proc = Bun.spawn([shell, '-l', '-c', nameGenLine()], {
      stdin: firstPrompt ? buildTaskNamePrompt(firstPrompt) : buildNamePrompt(clip),
      stdout: 'pipe',
      cwd: process.env.HOME || process.cwd(),
      env: cleanEnv(),
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const name = cleanName(out) || fallback
    return name ? { ok: true, message: name } : { ok: false, message: 'No name produced.' }
  } catch {
    if (fallback) return { ok: true, message: fallback }
    return { ok: false, message: 'AI naming failed — is the claude CLI on PATH?' }
  }
}
