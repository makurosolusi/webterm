// Read-only context-link backend: pure render/resolve helpers, the claude JSONL
// transcript parser (ported from nodeterm-web), the POSIX-sh shim installer, and
// the renderForRequester entry the GET /api/context-link route calls. No write/
// inject path — a linked node only ever READS a peer it is bridged to.
import type { Workspace } from '../shared/workspace'
import { dataDir } from './config'
import { TOKEN_HEADER } from './auth'
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ContextLinkVerb = 'list' | 'summary' | 'transcript' | 'terminal'
export const CONTEXT_LINK_VERBS: ContextLinkVerb[] = ['list', 'summary', 'transcript', 'terminal']
export interface LinkDocEntry { id: string; title: string; agent?: string; sessionId?: string }
export interface LinkDoc { links: LinkDocEntry[] }

const SUMMARY_DEFAULT_LINES = 15
const TOOL_ARG_MAX = 200
const TOOL_RESULT_MAX = 500

// --- claude transcript parser (ported verbatim from nodeterm-web) ---

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Claude tool_result content: a string, or content parts carrying `.text`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const part = c as { type?: string; text?: string }
        return part && part.type === 'text' ? part.text ?? '' : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function toolArg(input: unknown): string {
  const i = input as Record<string, unknown> | undefined
  if (!i) return ''
  const a = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt
  return typeof a === 'string' ? ` ${a.slice(0, TOOL_ARG_MAX)}` : ''
}

/** One claude transcript JSONL line -> 0..n display strings. */
export function linesFromClaude(raw: string): string[] {
  const o = parseJson(raw) as { type?: string; message?: { content?: unknown } } | undefined
  if (!o) return []
  const content = o.message?.content
  const res: string[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`assistant: ${c.text}`)
      else if (c.type === 'tool_use') res.push(`  $ ${c.name || 'tool'}${toolArg(c.input)}`)
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; content?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`user: ${c.text}`)
      else if (c.type === 'tool_result') {
        const s = textOf(c.content).split('\n').slice(0, 3).join(' ').slice(0, TOOL_RESULT_MAX)
        if (s) res.push(`  = ${s}`)
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    res.push(`user: ${content}`)
  }
  return res
}

// webterm transcripts are claude jsonl only — no per-agent dispatch needed.
export function renderTranscriptLines(buf: string): string[] {
  const lines: string[] = []
  for (const raw of buf.split('\n')) if (raw.trim()) lines.push(...linesFromClaude(raw))
  return lines
}

// --- node selection + render strings (ported verbatim, minus the note branch) ---

export function pickLinkNode(doc: LinkDoc, want?: string): { node: LinkDocEntry } | { message: string } {
  const links = doc.links
  if (!links.length) return { message: 'No linked nodes. Draw a context-link edge from this node to another on the canvas.' }
  if (want) {
    const q = want.toLowerCase()
    const m = links.find((n) => n.id.toLowerCase() === q || (n.title || '').toLowerCase() === q)
    if (!m) return { message: `No linked node matches "${want}". Linked: ${links.map((n) => n.title).join(', ')}` }
    return { node: m }
  }
  if (links.length === 1) return { node: links[0] }
  return { message: ['Several linked nodes — re-run with --node <id|title>:', ...links.map((n) => `- ${n.title} (id: ${n.id})`)].join('\n') }
}

export function renderList(doc: LinkDoc): string {
  if (!doc.links.length) return 'No linked nodes.'
  return ['Linked nodes:', ...doc.links.map((n) => `- ${n.title} (id: ${n.id})`)].join('\n')
}

export function renderSummary(node: LinkDocEntry, lines: string[], n: number): string {
  return [`=== ${node.title} — last ${n} lines ===`, ...lines.slice(-n)].join('\n')
}

export function renderFullTranscript(node: LinkDocEntry, lines: string[]): string {
  return [`=== ${node.title} — full transcript (${lines.length} lines) ===`, ...lines].join('\n')
}

export function renderTerminal(node: LinkDocEntry, capture: string): string {
  const body = capture.replace(/\s+$/, '')
  return [`=== ${node.title} — terminal ===`, body || `"${node.title}" terminal session is not running.`].join('\n')
}

export function parseSummaryCount(raw: string | undefined): number {
  const n = parseInt(raw || '', 10)
  return Number.isFinite(n) && n > 0 ? n : SUMMARY_DEFAULT_LINES
}

// Strip CSI + OSC escapes so a reading agent sees text, not control codes.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '')
}

// --- authorization: resolve the requester's link doc from its own workspace ---

export function buildLinkDoc(ws: Workspace, requesterId: string): LinkDoc {
  const peerIds = new Set<string>()
  for (const b of ws.bridges) {
    if (b.source === requesterId) peerIds.add(b.target)
    else if (b.target === requesterId) peerIds.add(b.source)
  }
  const links: LinkDocEntry[] = []
  for (const id of peerIds) {
    const n = ws.nodes.find((x) => x.id === id)
    if (n) links.push({ id: n.id, title: n.title || n.id, agent: n.agentId, sessionId: n.sessionId })
  }
  return { links }
}

export function findWorkspaceFor(list: Workspace[], requesterId: string): Workspace | undefined {
  return list.find((ws) => ws.nodes.some((n) => n.id === requesterId))
}

// --- route entry (not pure — reads db, fs, sessions) ---

export async function renderForRequester(
  requesterId: string, verb: ContextLinkVerb, args: { node?: string; n?: string }
): Promise<string> {
  // Loaded lazily: ./db pulls bun:sqlite, which the node-env vitest suite (pure
  // helpers only) must never import at module top level.
  const { db } = await import('./db')
  const { sessions } = await import('./sessions')
  const ws = findWorkspaceFor(db.list(), requesterId)
  if (!ws) return 'Not a webterm agent node — nothing to read.'
  const doc = buildLinkDoc(ws, requesterId)
  if (verb === 'list') return renderList(doc)
  const picked = pickLinkNode(doc, args.node)
  if ('message' in picked) return picked.message
  const node = picked.node
  if (verb === 'terminal') return renderTerminal(node, stripAnsi(sessions.getTerminal(node.id)))
  // summary | transcript — claude jsonl transcript fed by the hook
  const path = sessions.getTranscript(node.id)
  let buf: string | null = null
  if (path) { try { buf = readFileSync(path, 'utf8') } catch { buf = null } }
  if (buf == null) return `"${node.title}" has no conversation transcript yet.`
  const lines = renderTranscriptLines(buf)
  return verb === 'summary' ? renderSummary(node, lines, parseSummaryCount(args.n)) : renderFullTranscript(node, lines)
}

// --- shim + skill builders (pure strings; the installer below is the only fs part) ---

/** POSIX single-quote escape, so a token containing `'` cannot break out of the shim's quoting. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The POSIX-sh thin client the skill tells an agent to run. The server does all the reading and
 * rendering; this only forwards the caller's own node id.
 *
 * `token` is the transport token this process enforces (`resolveToken`). When one is in force the
 * shim MUST present it in `TOKEN_HEADER` or `/api` answers 403 — the loopback default has none,
 * and then no header is emitted at all rather than an empty one.
 */
export function buildContextShim(token?: string): string {
  const auth = token ? `  -H ${shQuote(`${TOKEN_HEADER}: ${token}`)} \\\n` : ''
  return `#!/bin/sh
# webterm context-link shim (generated — do not edit). Thin client: the server reads & renders.
if [ -z "$NODETERM_NODE_ID" ]; then
  echo "Not a webterm session (NODETERM_NODE_ID unset) — nothing to read."
  exit 0
fi
PORT="\${NODETERM_PORT:-8700}"
verb="\${1:-list}"; [ "$#" -gt 0 ] && shift
want=""; n=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --node) want="$2"; shift 2 ;;
    -n) n="$2"; shift 2 ;;
    *) shift ;;
  esac
done
curl -s --get \\
${auth}  --data-urlencode "node=\${NODETERM_NODE_ID}" \\
  --data-urlencode "verb=\${verb}" \\
  --data-urlencode "want=\${want}" \\
  --data-urlencode "n=\${n}" \\
  "http://127.0.0.1:\${PORT}/api/context-link"
`
}

/** Skill directory + front-matter `name`. Deliberately NOT `get-linked-context`: that name
 *  belongs to the hand-installed skill some users already have, and this file is overwritten
 *  on every boot. */
export const SKILL_NAME = 'webterm-linked-context'

/**
 * The SKILL.md body that tells an agent the shim exists. Describes what the route ACTUALLY serves
 * (see `renderForRequester`): four verbs, the whole retained scrollback for `terminal`, and
 * claude-only transcripts. No sticky-anything and no remote-host guidance — webterm has neither.
 */
export function buildContextLinkSkillBody(shimPath: string): string {
  return `---
name: ${SKILL_NAME}
description: Read a linked webterm node's conversation transcript, a recent summary, or its terminal scrollback. Use when another agent node on the webterm canvas is wired to this one by a context-link edge and you need to know what it has been doing, hand off, or continue its work.
---

<!-- Generated by webterm on start. Hand edits are overwritten the next time it boots. -->

# Linked context (webterm)

This session may be wired to other agent nodes on the webterm canvas by a context-link edge.
When it is, you can READ a wired node's context on demand by running the shim below. Nothing is
ever pushed to you — pull what you need, when you need it.

\`\`\`sh
${shimPath} <command> [--node <id|title>] [-n <N>]
\`\`\`

Commands:
- \`list\` — the nodes this one is linked to (start here; it is also the default).
- \`summary [--node X] [-n 15]\` — the last N lines of a linked node's conversation, 15 by default.
- \`transcript [--node X]\` — a linked node's full conversation transcript.
- \`terminal [--node X]\` — a linked node's terminal output, escape codes stripped. This is the
  whole scrollback webterm still holds for that session, not just the visible screen.

\`--node\` is optional when exactly one node is linked; otherwise pass an id or title from
\`list\`.

Only Claude sessions record a conversation transcript — webterm collects it through a Claude
hook. For a peer running any other agent, \`summary\` and \`transcript\` answer "has no
conversation transcript yet", so read that peer with \`terminal\` instead.

You can only ever read nodes linked to THIS one: webterm decides what you may see from the
caller's own id, so naming a node that is not in \`list\` gains nothing.

If the shim answers "Not a webterm session", "Not a webterm agent node" or "No linked nodes",
there is nothing to read — do not retry.
`
}

// --- installer (the only fs writer here; runs once at boot) ---

export function contextShimPath(): string {
  return join(dataDir(), 'context-links', 'context.sh')
}

/**
 * Write both halves of the feature: the shim, and the skill that tells an agent it exists.
 * Idempotent — a plain overwrite every boot, since both files are generated.
 *
 * The skill is the ONLY thing webterm writes outside WEBTERM_DATA_DIR, and it stays inside one
 * directory of its own so a hand-installed `get-linked-context` is never clobbered.
 */
export function installContextLink(token?: string): void {
  const file = contextShimPath()
  mkdirSync(join(dataDir(), 'context-links'), { recursive: true })
  writeFileSync(file, buildContextShim(token))
  // 0700, not 0755: with a token in force the shim carries a credential, and only this same
  // user's own agent sessions ever run it.
  chmodSync(file, 0o700)

  const skillDir = join(homedir(), '.claude', 'skills', SKILL_NAME)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), buildContextLinkSkillBody(file))
}
