import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../shared/workspace'
import { TOKEN_HEADER } from './auth'
import {
  buildContextShim,
  buildContextLinkSkillBody,
  contextShimPath,
  SKILL_NAME,
  CONTEXT_LINK_VERBS,
  linesFromClaude,
  renderTranscriptLines,
  renderList,
  pickLinkNode,
  renderSummary,
  renderFullTranscript,
  renderTerminal,
  parseSummaryCount,
  stripAnsi,
  buildLinkDoc,
  findWorkspaceFor,
  type LinkDoc,
} from './contextLink'

const node = (id: string, title: string): { id: string; title: string } => ({ id, title })

describe('linesFromClaude', () => {
  it('assistant text', () => {
    expect(linesFromClaude(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toEqual(['assistant: hi'])
  })
  it('assistant tool_use', () => {
    expect(linesFromClaude(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }))).toEqual(['  $ Bash ls'])
  })
  it('user tool_result', () => {
    expect(linesFromClaude(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toEqual(['  = ok'])
  })
  it('non-JSON line', () => {
    expect(linesFromClaude('not json')).toEqual([])
  })
})

describe('renderTranscriptLines', () => {
  it('flattens multi-line buffer, skips blanks', () => {
    const buf = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      '',
      '   ',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } }),
    ].join('\n')
    expect(renderTranscriptLines(buf)).toEqual(['user: hello', 'assistant: world'])
  })
})

describe('renderList', () => {
  it('empty doc', () => {
    expect(renderList({ links: [] })).toBe('No linked nodes.')
  })
  it('one link', () => {
    expect(renderList({ links: [node('a', 'Foo')] })).toBe('Linked nodes:\n- Foo (id: a)')
  })
})

describe('pickLinkNode', () => {
  it('empty → draw-edge message', () => {
    const r = pickLinkNode({ links: [] })
    expect(r).toEqual({ message: 'No linked nodes. Draw a context-link edge from this node to another on the canvas.' })
  })
  it('want with no match', () => {
    const r = pickLinkNode({ links: [node('a', 'Foo'), node('b', 'Bar')] }, 'x')
    expect(r).toEqual({ message: 'No linked node matches "x". Linked: Foo, Bar' })
  })
  it('two links, no want → several-nodes message', () => {
    const r = pickLinkNode({ links: [node('a', 'Foo'), node('b', 'Bar')] })
    expect(r).toEqual({ message: 'Several linked nodes — re-run with --node <id|title>:\n- Foo (id: a)\n- Bar (id: b)' })
  })
  it('single link, no want → that node', () => {
    expect(pickLinkNode({ links: [node('a', 'Foo')] })).toEqual({ node: node('a', 'Foo') })
  })
  it('want matches title case-insensitively', () => {
    expect(pickLinkNode({ links: [node('a', 'Foo')] }, 'foo')).toEqual({ node: node('a', 'Foo') })
  })
})

describe('renderSummary', () => {
  it('header + last n lines', () => {
    expect(renderSummary(node('a', 'Foo'), ['1', '2', '3'], 2)).toBe('=== Foo — last 2 lines ===\n2\n3')
  })
})

describe('renderFullTranscript', () => {
  it('header reports line count', () => {
    expect(renderFullTranscript(node('a', 'Foo'), ['1', '2'])).toBe('=== Foo — full transcript (2 lines) ===\n1\n2')
  })
})

describe('renderTerminal', () => {
  it('non-empty trimmed', () => {
    expect(renderTerminal(node('a', 'Foo'), 'out\n\n')).toBe('=== Foo — terminal ===\nout')
  })
  it('empty → not-running message', () => {
    expect(renderTerminal(node('a', 'Foo'), '')).toBe('=== Foo — terminal ===\n"Foo" terminal session is not running.')
  })
})

describe('parseSummaryCount', () => {
  it('defaults and parses', () => {
    expect(parseSummaryCount(undefined)).toBe(15)
    expect(parseSummaryCount('5')).toBe(5)
    expect(parseSummaryCount('0')).toBe(15)
    expect(parseSummaryCount('abc')).toBe(15)
  })
})

describe('stripAnsi', () => {
  it('strips CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })
})

function ws(nodes: { id: string; title?: string }[], bridges: { source: string; target: string }[]): Workspace {
  return {
    id: 'w1',
    name: 'w',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map((n) => ({ id: n.id, kind: 'agent', x: 0, y: 0, title: n.title })),
    bridges: bridges.map((b, i) => ({ id: `br${i}`, source: b.source, target: b.target, kind: 'context' })),
    updatedAt: 0,
  } as Workspace
}

describe('buildLinkDoc', () => {
  it('requester a bridged to b and c → links for b and c', () => {
    const w = ws([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }], [{ source: 'a', target: 'b' }, { source: 'c', target: 'a' }])
    const doc: LinkDoc = buildLinkDoc(w, 'a')
    expect(doc.links.map((l) => l.id).sort()).toEqual(['b', 'c'])
    expect(doc.links.find((l) => l.id === 'b')?.title).toBe('B')
  })
  it('requester z not bridged → empty', () => {
    const w = ws([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }])
    expect(buildLinkDoc(w, 'z').links).toEqual([])
  })
})

describe('findWorkspaceFor', () => {
  it('returns the ws containing the node', () => {
    const w = ws([{ id: 'a' }], [])
    expect(findWorkspaceFor([w], 'a')).toBe(w)
  })
  it('undefined when none', () => {
    const w = ws([{ id: 'a' }], [])
    expect(findWorkspaceFor([w], 'nope')).toBeUndefined()
  })
})

// A fake, test-only token. NEVER read the real one from the environment: that would print a
// secret into assertion diffs on the first failure.
const FAKE_TOKEN = 'tok-for-tests-only' // test-only

describe('buildContextShim', () => {
  it('sends the transport token in the header auth actually checks', () => {
    const shim = buildContextShim(FAKE_TOKEN)
    expect(shim).toContain(`-H '${TOKEN_HEADER}: ${FAKE_TOKEN}'`)
  })
  it('emits NO auth header at all when no token is in force', () => {
    const shim = buildContextShim()
    expect(shim).not.toContain(TOKEN_HEADER)
    expect(shim).not.toContain('-H')
  })
  it('keeps the request shape the route parses either way', () => {
    for (const shim of [buildContextShim(), buildContextShim(FAKE_TOKEN)]) {
      for (const p of ['node=', 'verb=', 'want=', 'n=']) expect(shim).toContain(`--data-urlencode "${p}`)
      expect(shim).toContain('/api/context-link')
      // Every continuation must still end in a backslash or the injected header breaks the curl.
      const lines = shim.split('\n')
      const curl = lines.findIndex((l) => l.startsWith('curl '))
      for (let i = curl; i < lines.length - 2; i++) expect(lines[i].endsWith('\\')).toBe(true)
    }
  })
  it('escapes a quote in the token instead of breaking out of the shell quoting', () => {
    expect(buildContextShim("a'b")).toContain(`-H '${TOKEN_HEADER}: a'\\''b'`)
  })
})

describe('buildContextLinkSkillBody', () => {
  const body = buildContextLinkSkillBody('/tmp/fake/context.sh')

  it('declares webterm’s own skill name, not the hand-installed one', () => {
    expect(body.startsWith(`---\nname: ${SKILL_NAME}\n`)).toBe(true)
    expect(SKILL_NAME).toBe('webterm-linked-context')
    expect(body).not.toContain('get-linked-context')
  })
  it('marks itself generated so a hand edit is not mistaken for durable', () => {
    expect(body).toContain('Generated by webterm')
  })
  it('points at the shim path it was given', () => {
    expect(body).toContain('/tmp/fake/context.sh <command>')
  })
  it('takes the shim path from dataDir(), not a hardcoded one', () => {
    const prev = process.env.WEBTERM_DATA_DIR
    process.env.WEBTERM_DATA_DIR = join(tmpdir(), `webterm-skill-${process.pid}`)
    try {
      const path = contextShimPath()
      expect(path.startsWith(process.env.WEBTERM_DATA_DIR)).toBe(true)
      expect(buildContextLinkSkillBody(path)).toContain(path)
    } finally {
      if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
      else process.env.WEBTERM_DATA_DIR = prev
    }
  })
  it('documents every verb the route serves', () => {
    for (const v of CONTEXT_LINK_VERBS) expect(body).toContain(`\`${v}`)
  })
  // Anti-drift: these are the nodeterm paragraphs that must NOT be pasted back in. webterm has
  // no sticky nodes, and is single-user loopback — no tunnel, no remote host, no sandbox.
  it('promises nothing webterm does not have', () => {
    for (const wrong of [/sticky/i, /\(note\)/, /tunnel/i, /\bssh\b/i, /sandbox/i, /unreachable/i]) {
      expect(body).not.toMatch(wrong)
    }
  })
  it('does not call the terminal verb a visible buffer — the server sends whole scrollback', () => {
    expect(body).not.toMatch(/visible buffer/i)
    expect(body).toContain('scrollback')
  })
  it('says webterm, never nodeterm, on the user-visible surface', () => {
    expect(body).not.toContain('nodeterm')
    expect(body).toContain('webterm')
  })
  it('is honest that only claude peers have a transcript', () => {
    expect(body).toMatch(/Only Claude sessions record a conversation transcript/)
  })
})
