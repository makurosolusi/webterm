import { describe, expect, it } from 'vitest'
import { buildNodeList, nodeRowLabel } from './nodeList'
import type { Workspace, WsNode } from '../shared/workspace'

const node = (id: string, kind: WsNode['kind'] = 'terminal', extra: Partial<WsNode> = {}): WsNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...extra,
})

const ws = (id: string, name: string, nodes: WsNode[]): Workspace => ({
  id,
  name,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  bridges: [],
  updatedAt: 0,
})

describe('buildNodeList', () => {
  it('memuat node files dan editor — tab ini satu-satunya jalan memusatkan canvas ke keduanya', () => {
    const nodes = [node('t', 'terminal'), node('a', 'agent'), node('f', 'files'), node('e', 'editor')]
    const rows = buildNodeList([ws('w1', 'makuro', nodes)], null, 'w1', '')
    expect(rows.map((r) => r.kind).sort()).toEqual(['agent', 'editor', 'files', 'terminal'])
  })

  it('workspace aktif memakai node canvas, bukan snapshot — judul baru hanya ada di sana', () => {
    const saved = ws('w1', 'makuro', [node('n1', 'terminal', { title: 'lama' })])
    const rows = buildNodeList([saved], [node('n1', 'terminal', { title: 'baru' })], 'w1', '')
    expect(rows.map((r) => r.label)).toEqual(['baru'])
  })

  it('node workspace non-aktif tetap ikut, dan workspace aktif didahulukan', () => {
    const a = ws('w1', 'satu', [node('n1')])
    const b = ws('w2', 'dua', [node('n2')])
    const rows = buildNodeList([a, b], null, 'w2', '')
    expect(rows.map((r) => r.id)).toEqual(['n2', 'n1'])
    expect(rows.map((r) => r.isActive)).toEqual([true, false])
  })

  it('filter menyaring lewat judul, kind, path, dan nama workspace', () => {
    const nodes = [
      node('n1', 'terminal', { title: 'build' }),
      node('n2', 'editor', { filePath: '/repo/api.ts' }),
      node('n3', 'files', { dirPath: '/repo/src' }),
    ]
    const list = [ws('w1', 'makuro', nodes)]
    expect(buildNodeList(list, null, 'w1', 'build').map((r) => r.id)).toEqual(['n1'])
    expect(buildNodeList(list, null, 'w1', 'api.ts').map((r) => r.id)).toEqual(['n2'])
    expect(buildNodeList(list, null, 'w1', 'files').map((r) => r.id)).toEqual(['n3'])
    expect(buildNodeList(list, null, 'w1', 'makuro').map((r) => r.id)).toEqual(['n2', 'n1', 'n3'])
    expect(buildNodeList(list, null, 'w1', 'zzz')).toEqual([])
  })

  it('board tanpa node memberi daftar kosong, bukan baris hantu', () => {
    expect(buildNodeList([ws('w1', 'makuro', [])], null, 'w1', '')).toEqual([])
    expect(buildNodeList([], null, null, '')).toEqual([])
  })

  it('membawa path node sebagai detail, per kind', () => {
    const nodes = [
      node('n1', 'terminal', { cwd: '/tmp' }),
      node('n2', 'files', { dirPath: '/repo/src' }),
      node('n3', 'editor', { filePath: '/repo/api.ts' }),
    ]
    const rows = buildNodeList([ws('w1', 'makuro', nodes)], null, 'w1', '')
    expect(rows.map((r) => [r.id, r.detail])).toEqual([
      ['n3', '/repo/api.ts'],
      ['n2', '/repo/src'],
      ['n1', '/tmp'],
    ])
  })
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
