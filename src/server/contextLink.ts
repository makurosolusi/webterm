// Read-only context-link backend: pure render/resolve helpers, the claude JSONL
// transcript parser (ported from nodeterm-web), the POSIX-sh shim installer, and
// the renderForRequester entry the GET /api/context-link route calls. No write/
// inject path — a linked node only ever READS a peer it is bridged to.
import type { Workspace } from '../shared/workspace'
import { dataDir } from './config'
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
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

// --- shim installer (writes the POSIX-sh thin client at boot) ---

const SHIM = `#!/bin/sh
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
  --data-urlencode "node=\${NODETERM_NODE_ID}" \\
  --data-urlencode "verb=\${verb}" \\
  --data-urlencode "want=\${want}" \\
  --data-urlencode "n=\${n}" \\
  "http://127.0.0.1:\${PORT}/api/context-link"
`

export function installContextLinkShim(): void {
  const dir = join(dataDir(), 'context-links')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'context.sh')
  writeFileSync(file, SHIM)
  chmodSync(file, 0o755)
}
