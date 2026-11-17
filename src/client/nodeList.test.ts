import { describe, expect, it } from 'vitest'
import { KIND_ICON, NODE_KIND_LABEL, nodeRowLabel } from './nodeList'
import { sessionLabel } from './sessionList'
import type { WsNode } from '../shared/workspace'

const node = (id: string, kind: WsNode['kind'] = 'terminal', extra: Partial<WsNode> = {}): WsNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...extra,
})

describe('nodeRowLabel', () => {
  it('judul kustom selalu menang', () => {
    expect(nodeRowLabel(node('n1', 'files', { title: 'docs', dirPath: '/repo/src' }))).toBe('docs')
  })

  it('a NodeChrome rename of an editor, diff, plan or app node names its tab, over the file name', () => {
    expect(nodeRowLabel(node('n1', 'editor', { title: 'notes', filePath: '/repo/api.ts' }))).toBe('notes')
    expect(nodeRowLabel(node('n2', 'diff', { title: 'review' }))).toBe('review')
    expect(nodeRowLabel(node('n3', 'plan', { title: 'roadmap' }))).toBe('roadmap')
    expect(nodeRowLabel(node('n4', 'app', { title: 'dashboard' }))).toBe('dashboard')
    // A blank rename falls back to the file name.
    expect(nodeRowLabel(node('n5', 'editor', { title: '  ', filePath: '/repo/api.ts' }))).toBe('api.ts')
  })

  it('tanpa judul: tiap kind tetap bisa dibedakan dari path atau agent-nya', () => {
    expect(nodeRowLabel(node('n1', 'files', { dirPath: '/repo/src' }))).toBe('src')
    expect(nodeRowLabel(node('n2', 'editor', { filePath: '/repo/api.ts' }))).toBe('api.ts')
    expect(nodeRowLabel(node('n3', 'agent', { agentId: 'claude' }))).toBe('Claude Code')
    expect(nodeRowLabel(node('n4', 'terminal'))).toBe('Terminal')
  })

  it('kind tanpa path pun tidak pernah kosong', () => {
    expect(nodeRowLabel(node('n1', 'files'))).toBe('Files')
    expect(nodeRowLabel(node('n2', 'editor'))).toBe('Editor')
  })

  it('is the label without the node name (the tab strip shows the name itself); a legacy auto title falls back to the kind', () => {
    expect(nodeRowLabel(node('n1', 'terminal', { name: 'Mango', title: 'api' }))).toBe('api')
    expect(nodeRowLabel(node('n2', 'agent', { name: 'Otter', agentId: 'claude', title: 'brisk-otter' }))).toBe('Claude Code')
  })
})

describe('nodeRowLabel per kind (untitled)', () => {
  // Every kind, untitled and without a path: its own label, never another kind's ("Terminal").
  const EXPECTED: Record<WsNode['kind'], string> = {
    terminal: 'Terminal', agent: 'Agent', agentChat: 'Agent Chat', files: 'Files', editor: 'Editor',
    browser: 'Browser', diff: 'Changes', plan: 'Plan', app: 'App', skill: 'Skill',
  }
  it('covers every kind', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(NODE_KIND_LABEL).sort())
  })
  for (const kind of Object.keys(EXPECTED) as WsNode['kind'][]) {
    it(`${kind} → ${EXPECTED[kind]}`, () => {
      expect(nodeRowLabel(node('n1', kind))).toBe(EXPECTED[kind])
      expect(nodeRowLabel(node('n1', kind, { title: '  ' }))).toBe(EXPECTED[kind])
    })
  }

  it('an Agent Chat is "Agent Chat" even with its agentId, in tabs and in the sidebar', () => {
    const chat = node('n1', 'agentChat', { agentId: 'claude', name: 'Orchid' })
    expect(nodeRowLabel(chat)).toBe('Agent Chat')
    expect(sessionLabel(chat)).toBe('Orchid · Agent Chat')
  })
})

describe('KIND_ICON', () => {
  it('maps every kind to a codicon', () => {
    expect(KIND_ICON).toMatchObject({ agent: 'hubot', terminal: 'terminal', editor: 'file', files: 'folder', browser: 'globe' })
  })
})
