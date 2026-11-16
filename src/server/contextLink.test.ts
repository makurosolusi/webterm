import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../shared/workspace'
import { TOKEN_HEADER } from './auth'
import {
  buildContextShim,
  buildContextLinkSkillBody,
  contextShimPath,
  installContextLink,
  readTranscriptFile,
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
import { linkedPeerIds } from './contextLinkRoute'
import { CONTEXT_COMMAND } from './cli/cli.commands'
import { buildWebtermCli, cliPath } from './cli/cli.launcher'

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
    expect(r).toEqual({ message: 'Several linked nodes — re-run with --node <name|id|title>:\n- Foo (id: a)\n- Bar (id: b)' })
  })
  it('names: matched case-insensitively (id first, then name, then title) and shown in every message', () => {
    const kiwi = { id: 'a', name: 'Kiwi', title: 'Build log' }
    const links = [kiwi, { id: 'b', name: 'Fox', title: 'kiwi' }]
    expect(pickLinkNode({ links }, 'KIWI')).toEqual({ node: kiwi })
    expect(pickLinkNode({ links }, 'b')).toEqual({ node: links[1] })
    expect(pickLinkNode({ links }, 'x')).toEqual({ message: 'No linked node matches "x". Linked: Kiwi "Build log", Fox "kiwi"' })
    expect(pickLinkNode({ links })).toMatchObject({ message: expect.stringContaining('\n- Kiwi "Build log" (id: a)') })
    expect(renderList({ links: [kiwi] })).toBe('Linked nodes:\n- Kiwi "Build log" (id: a)')
    expect(renderTerminal(kiwi, 'out')).toBe('=== Kiwi "Build log" — terminal ===\nout')
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
    w.nodes[1].name = 'Kiwi'
    expect(buildLinkDoc(w, 'a').links.find((l) => l.id === 'b')?.name).toBe('Kiwi')
  })
  it('requester z not bridged → empty', () => {
    const w = ws([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }])
    expect(buildLinkDoc(w, 'z').links).toEqual([])
  })
  it('browser yang dikabel tidak masuk daftar context-link, tapi tetap peer kabel', () => {
    const w = ws([{ id: 'a' }, { id: 'b' }, { id: 'web' }], [{ source: 'a', target: 'b' }, { source: 'web', target: 'a' }])
    w.nodes[2].kind = 'browser'
    expect(buildLinkDoc(w, 'a').links.map((l) => l.id)).toEqual(['b'])
    expect(linkedPeerIds(w, 'a').has('web')).toBe(true)
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

// Fake, test-only tokens. NEVER read the real ones from the environment: that would print a
// secret into assertion diffs on the first failure.
const FAKE_ROOT_TOKEN = 'root-token-for-tests-only' // test-only
const FAKE_NODE_TOKEN = '11111111-2222-4333-8444-555555555555' // test-only, UUID alphabet
const FAKE_FALLBACK_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' // test-only, UUID alphabet

describe('buildContextShim', () => {
  it('is a one-line alias of `webterm context`', () => {
    expect(buildContextShim()).toContain(`exec '${cliPath()}' context "$@"`)
    execFileSync('sh', ['-n'], { input: buildContextShim() })
  })
  it('the CLI hands curl the node header file named by the env, never a token value or token env', () => {
    const shim = buildWebtermCli()
    expect(shim).toContain('-H "@$hdr"')
    expect(shim).toContain('WEBTERM_NODE_HEADERS')
    expect(shim).not.toContain(`${TOKEN_HEADER}:`)
    expect(shim).not.toMatch(/WEBTERM_TOKEN|WEBTERM_NODE_TOKEN/)
  })
  it('keeps the request shape the route parses', () => {
    for (const p of ['node=', 'verb=', 'want=', 'n=']) expect(CONTEXT_COMMAND).toContain(`--data-urlencode "${p}`)
    expect(CONTEXT_COMMAND).toContain('/api/context-link')
    // Every continuation must still end in a backslash or the header breaks the curl line.
    const lines = CONTEXT_COMMAND.split('\n')
    const curl = lines.findIndex((l) => l.startsWith('curl '))
    for (let i = curl; i < lines.length - 2; i++) expect(lines[i].endsWith('\\')).toBe(true)
  })
  it('the CLI is valid POSIX sh', () => {
    execFileSync('sh', ['-n'], { input: buildWebtermCli() })
  })
})

/** Run a generated shim with a stubbed `curl`; return the argv that stub received. */
function curlArgvOfShim(shim: string, env: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-context-curl-'))
  try {
    const out = join(dir, 'argv')
    // Interpreter absolut supaya PATH boleh memuat shim SAJA: `curl` di baris itu tidak mungkin
    // me-resolve ke curl sungguhan, yang akan menembak dev server di port 8700 bila ada.
    writeFileSync(join(dir, 'curl'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$ARGV_OUT"; done\n', {
      mode: 0o755,
    })
    const script = join(dir, 'webterm')
    writeFileSync(script, shim, { mode: 0o755 })
    // The context shim is an alias of `webterm context`: run that command of the CLI itself.
    execFileSync('/bin/sh', ['-c', `${script} context </dev/null`], {
      env: { PATH: dir, ARGV_OUT: out, WEBTERM_NODE_ID: 'n-shipped', ...env },
    })
    return readFileSync(out, 'utf8').split('\n').slice(0, -1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function headerOf(argv: string[]): string | undefined {
  return argv[argv.indexOf('-H') + 1]
}

describe('the header curl actually receives', () => {
  it('is @<the node header file>, and no token value reaches argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-context-hdr-'))
    try {
      const hdr = join(dir, 'node.headers')
      writeFileSync(hdr, `${TOKEN_HEADER}: ${FAKE_NODE_TOKEN}\n`, { mode: 0o600 })
      const argv = curlArgvOfShim(buildWebtermCli(), { WEBTERM_NODE_HEADERS: hdr })
      expect(headerOf(argv)).toBe(`@${hdr}`)
      expect(argv.filter((a) => a === '-H')).toHaveLength(1)
      expect(argv.join('\n')).not.toContain(FAKE_NODE_TOKEN)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('ignores a token in env and does not call curl without a readable header file', () => {
    for (const env of <Record<string, string>[]>[{ WEBTERM_TOKEN: FAKE_NODE_TOKEN, WEBTERM_NODE_TOKEN: FAKE_FALLBACK_TOKEN }, { WEBTERM_NODE_HEADERS: '/nonexistent/h' }]) {
      expect(() => curlArgvOfShim(buildWebtermCli(), env)).toThrow() // argv file never written
    }
  })
})

describe('installContextLink', () => {
  /** Point both the data dir and HOME at a scratch dir: the installer also writes the skill. */
  function withScratch<T>(fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-context-install-'))
    const prevData = process.env.WEBTERM_DATA_DIR
    const prevHome = process.env.HOME
    const prevToken = process.env.WEBTERM_TOKEN
    process.env.WEBTERM_DATA_DIR = dir
    process.env.HOME = dir
    process.env.WEBTERM_TOKEN = FAKE_ROOT_TOKEN
    try {
      return fn()
    } finally {
      if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
      else process.env.WEBTERM_DATA_DIR = prevData
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevToken === undefined) delete process.env.WEBTERM_TOKEN
      else process.env.WEBTERM_TOKEN = prevToken
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('writes a 0700 shim that contains no token value, even with a root token in force', () => {
    withScratch(() => {
      installContextLink(FAKE_ROOT_TOKEN)
      const file = contextShimPath()
      expect(statSync(file).mode & 0o777).toBe(0o700)
      const shim = readFileSync(file, 'utf8')
      const cli = readFileSync(cliPath(), 'utf8')
      expect(statSync(cliPath()).mode & 0o777).toBe(0o700)
      expect(shim + cli).not.toContain(FAKE_ROOT_TOKEN)
      expect(cli).toContain('-H "@$hdr"')
      // No literal header value of any kind.
      expect(shim + cli).not.toContain(`${TOKEN_HEADER}:`)
    })
  })

  it('WEBTERM_SKIP_HOME_INSTALLS=1 (dev:fresh): shim and CLI in the data dir, no skill under HOME', () => {
    withScratch(() => {
      process.env.WEBTERM_SKIP_HOME_INSTALLS = '1'
      try { installContextLink() } finally { delete process.env.WEBTERM_SKIP_HOME_INSTALLS }
      expect(existsSync(contextShimPath()) && existsSync(cliPath())).toBe(true)
      expect(existsSync(join(process.env.HOME as string, '.claude'))).toBe(false)
    })
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
  // Anti-drift: these are the reference-client paragraphs that must NOT be pasted back in. webterm has
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

describe('readTranscriptFile', () => {
  const withDataDir = <T,>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-transcript-'))
    const prev = process.env.WEBTERM_DATA_DIR
    process.env.WEBTERM_DATA_DIR = dir
    try {
      return fn(dir)
    } finally {
      if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
      else process.env.WEBTERM_DATA_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reads a regular file inside the data dir', () => {
    withDataDir((dir) => {
      const file = join(dir, 't.jsonl')
      writeFileSync(file, '{"type":"user"}\n')
      expect(readTranscriptFile(file)).toBe('{"type":"user"}\n')
    })
  })

  it('refuses a symlink swapped in after validation', () => {
    withDataDir((dir) => {
      const secret = join(tmpdir(), `webterm-secret-${process.pid}.jsonl`)
      writeFileSync(secret, '{"secret":true}\n')
      const link = join(dir, 't.jsonl')
      symlinkSync(secret, link)
      try {
        expect(readTranscriptFile(link)).toBeNull()
      } finally {
        rmSync(secret, { force: true })
      }
    })
  })

  it('refuses paths outside the allowed roots and non-regular files', () => {
    expect(readTranscriptFile('/etc/passwd')).toBeNull()
    expect(readTranscriptFile('/dev/zero')).toBeNull()
  })
})
