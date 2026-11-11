import { describe, expect, it } from 'vitest'
import { effectiveWrap, wrapByDefault } from './editorWrap'
import { toFlow, toWsNode } from './store'
import { normalizeWorkspace } from '../shared/workspace.schema'

describe('word wrap default, like VS Code', () => {
  it('is on for Markdown, plain text and extension-less text; off for code, dotfiles and build files', () => {
    for (const p of ['/r/README.md', '/r/a.markdown', '/r/b.MDX', '/r/notes.txt', '/r/LICENSE', '/r/README', '/r/CHANGELOG', '/r/NOTES']) expect(wrapByDefault(p)).toBe(true)
    for (const p of ['/r/a.ts', '/r/b.json', '/r/c.py', '/r/d.sh', '/r/.env', '/r/.gitignore', '/r/.zshrc', '/r/Dockerfile', '/r/Makefile', '/r/Procfile', '/r/Justfile']) expect(wrapByDefault(p)).toBe(false)
  })
  it('a stored boolean wins over the default; anything else falls back to it', () => {
    expect(effectiveWrap(false, '/r/README.md')).toBe(false)
    expect(effectiveWrap(true, '/r/a.ts')).toBe(true)
    expect(effectiveWrap('yes', '/r/a.ts')).toBe(false)
  })
})

describe('wordWrap persists on the node', () => {
  it('round-trips through the client serializers; junk and absent stay absent', () => {
    expect(toWsNode(toFlow({ id: 'e', kind: 'editor', x: 0, y: 0, wordWrap: false })).wordWrap).toBe(false)
    expect(toWsNode(toFlow({ id: 'e', kind: 'editor', x: 0, y: 0 })).wordWrap).toBeUndefined()
    expect(toWsNode({ id: 'e', type: 'editor', position: { x: 0, y: 0 }, data: { wordWrap: 'on' } }).wordWrap).toBeUndefined()
  })
  it('the server board schema keeps a boolean and drops anything else', () => {
    const board = (wordWrap: unknown) => normalizeWorkspace({ name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'e', kind: 'editor', x: 0, y: 0, wordWrap }] })
    expect(board(true).board.nodes[0].wordWrap).toBe(true)
    expect(board(false).board.nodes[0].wordWrap).toBe(false)
    expect('wordWrap' in board('on').board.nodes[0]).toBe(false)
  })
})
