// Prompt worker: sanitasi escape terminal, pemotongan byte, id node deterministik, dan
// perakitan prompt. Semua fungsi murni supaya mudah diuji tanpa PTY.
import type { PlanItem } from './plan'

// ANSI CSI/OSC dan karakter kontrol (newline/tab dipertahankan) supaya teks yang dikembalikan
// bersih dari escape terminal sebelum dipotong dan disimpan.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function sanitizeText(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '')
}

export function capBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8')
}

/** Node id deterministik dari task+fence, selalu lolos `isSafeNodeId` (prefix `w-`). */
export function deriveNodeId(taskId: string, fence: number): string {
  return `w-${taskId}-${fence}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 64)
}

export function buildWorkerPrompt(args: {
  item: Pick<PlanItem, 'id' | 'title' | 'scope'>
  worktree: { path: string; branch: string }
  attempt: number
  maxBytes: number
  extra?: string
}): string {
  const scope = args.item.scope.map((entry) => `- ${entry}`).join('\n')
  const extra = args.extra === undefined || args.extra.trim() === '' ? '' : `\n\n${args.extra.trim()}`
  const prompt = [
    'You are a leaf worker agent in webterm. Work only inside the worktree below.',
    `Task: ${args.item.title}`,
    `Scope (touch only these paths):\n${scope}`,
    `Worktree: ${args.worktree.path}`,
    `Branch: ${args.worktree.branch}`,
    `Item: ${args.item.id} · attempt ${args.attempt}`,
    'Steps: implement the task, run the repo tests/typecheck, then commit locally with git.',
    'Do not push. Reply with a short summary; the orchestrator verifies independently.',
    extra,
  ]
    .join('\n')
    .trim()
  return capBytes(sanitizeText(prompt), args.maxBytes)
}
