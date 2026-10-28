import { describe, expect, it } from 'vitest'
import { buildNodeGroups, nodeRowLabel } from './nodeList'
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

describe('buildNodeGroups', () => {
  it('memuat node files dan editor — tab ini satu-satunya jalan memusatkan canvas ke keduanya', () => {
    const nodes = [node('t', 'terminal'), node('a', 'agent'), node('f', 'files'), node('e', 'editor')]
    const groups = buildNodeGroups([ws('w1', 'makuro', nodes)], null, 'w1', '')
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'terminal', 'editor', 'files'])
  })

  it('urutan grup dipaku, tak peduli urutan node datang', () => {
    const nodes = [node('f', 'files'), node('e', 'editor'), node('t', 'terminal'), node('a', 'agent')]
    const groups = buildNodeGroups([ws('w1', 'makuro', nodes)], null, 'w1', '')
    expect(groups.map((g) => [g.kind, g.label])).toEqual([
      ['agent', 'Agents'],
      ['terminal', 'Terminals'],
      ['editor', 'Editors'],
      ['files', 'Files'],
    ])
  })

  it('grup tanpa baris tidak muncul sebagai header kosong', () => {
    const groups = buildNodeGroups([ws('w1', 'makuro', [node('t', 'terminal')])], null, 'w1', '')
    expect(groups.map((g) => g.kind)).toEqual(['terminal'])
  })

  it('workspace aktif memakai node canvas, bukan snapshot — judul baru hanya ada di sana', () => {
    const saved = ws('w1', 'makuro', [node('n1', 'terminal', { title: 'lama' })])
    const groups = buildNodeGroups([saved], [node('n1', 'terminal', { title: 'baru' })], 'w1', '')
    expect(groups[0].rows.map((r) => r.label)).toEqual(['baru'])
  })

  it('di dalam grup: workspace aktif lebih dulu, lalu alfabet case-insensitive', () => {
    const a = ws('w1', 'satu', [node('n1', 'terminal', { title: 'beta' })])
    const b = ws('w2', 'dua', [
      node('n2', 'terminal', { title: 'Zeta' }),
      node('n3', 'terminal', { title: 'alfa' }),
    ])
    const groups = buildNodeGroups([a, b], null, 'w2', '')
    expect(groups[0].rows.map((r) => r.id)).toEqual(['n3', 'n2', 'n1'])
    expect(groups[0].rows.map((r) => r.isActive)).toEqual([true, true, false])
  })

  it('filter menyaring lewat judul, kind, path, dan nama workspace', () => {
    const nodes = [
      node('n1', 'terminal', { title: 'build' }),
      node('n2', 'editor', { filePath: '/repo/api.ts' }),
      node('n3', 'files', { dirPath: '/repo/src' }),
    ]
    const list = [ws('w1', 'makuro', nodes)]
    const shape = (filter: string) =>
      buildNodeGroups(list, null, 'w1', filter).map((g) => [g.kind, g.rows.map((r) => r.id)])

    expect(shape('build')).toEqual([['terminal', ['n1']]])
    expect(shape('api.ts')).toEqual([['editor', ['n2']]])
    expect(shape('files')).toEqual([['files', ['n3']]])
    expect(shape('makuro')).toEqual([
      ['terminal', ['n1']],
      ['editor', ['n2']],
      ['files', ['n3']],
    ])
    expect(buildNodeGroups(list, null, 'w1', 'zzz')).toEqual([])
  })

  it('board tanpa node memberi daftar kosong, bukan baris hantu', () => {
    expect(buildNodeGroups([ws('w1', 'makuro', [])], null, 'w1', '')).toEqual([])
    expect(buildNodeGroups([], null, null, '')).toEqual([])
  })

  it('membawa path node sebagai detail, per kind', () => {
    const nodes = [
      node('n1', 'terminal', { cwd: '/tmp' }),
      node('n2', 'files', { dirPath: '/repo/src' }),
      node('n3', 'editor', { filePath: '/repo/api.ts' }),
    ]
    const groups = buildNodeGroups([ws('w1', 'makuro', nodes)], null, 'w1', '')
    expect(groups.flatMap((g) => g.rows).map((r) => [r.id, r.detail])).toEqual([
      ['n1', '/tmp'],
      ['n3', '/repo/api.ts'],
      ['n2', '/repo/src'],
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
