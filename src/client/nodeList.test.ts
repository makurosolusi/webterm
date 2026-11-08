import { describe, expect, it } from 'vitest'
import { KIND_ICON, nodeRowLabel } from './nodeList'
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
})

describe('KIND_ICON', () => {
  it('maps every kind to a codicon', () => {
    expect(KIND_ICON).toMatchObject({ agent: 'hubot', terminal: 'terminal', editor: 'file', files: 'folder', browser: 'globe' })
  })
})
