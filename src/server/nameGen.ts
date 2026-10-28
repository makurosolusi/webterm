// AI name-gen: pure clip/prompt/clean helpers up top (unit-testable, node-env),
// plus one impure entry. generateName lazy-imports ./sessions (mirrors
// contextLink.ts) so the node-env vitest suite never pulls a bun module at load.
// Bun.spawn is typed locally (a narrow slice) because @types/bun reddens
// unrelated files — same reason pty.ts declares its own Bun types.

export function clipTerminal(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  return trimmed.split('\n').slice(-150).join('\n').slice(-8000)
}

export function buildNamePrompt(clip: string): string {
  return `Below is the recent output of a terminal session. Suggest a very short title (2-4 words, Title Case, no surrounding quotes, no trailing punctuation) describing what this terminal is used for. Output ONLY the title.\n\nTerminal output:\n\`\`\`\n${clip}\n\`\`\``
}

export function cleanName(raw: string): string {
  return raw.split('\n')[0].replace(/["'`.]+$/g, '').trim().slice(0, 40)
}

declare const Bun: {
  spawn(cmd: string[], options: { stdin: string; stdout: 'pipe'; cwd?: string; env?: Record<string, string> }): {
    stdout: ReadableStream<Uint8Array>; exited: Promise<number>
  }
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.TERM = 'xterm-256color'
  return env
}

export async function generateName(nodeId: string): Promise<{ ok: boolean; message: string }> {
  const { sessions } = await import('./sessions')
  const clip = clipTerminal(sessions.getTerminal(nodeId))
  if (!clip) return { ok: false, message: 'No terminal output to read yet.' }
  try {
    const shell = process.env.SHELL || 'bash'
    const proc = Bun.spawn([shell, '-l', '-c', 'claude -p'], {
      stdin: buildNamePrompt(clip),
      stdout: 'pipe',
      cwd: process.env.HOME || process.cwd(),
      env: cleanEnv(),
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const name = cleanName(out)
    return name ? { ok: true, message: name } : { ok: false, message: 'No name produced.' }
  } catch {
    return { ok: false, message: 'AI naming failed — is the claude CLI on PATH?' }
  }
}
