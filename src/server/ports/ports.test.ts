import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import type { AppendEventInput } from '../events/eventModel'
import { ownerOf, parseLsofListening, parseProcAddress, parseProcNetTcp, parsePsParents, parseTmuxPanes } from './ports.parse'
import { paneOwners, PortScanner, portUrl, type PortScanDeps } from './ports.service'
import { portsRoute } from './ports.runtime'

// test-only fixtures: real `lsof -nP -iTCP -sTCP:LISTEN -F pcn` shape (macOS).
const LSOF = [
  'p4242', 'cnode', 'f23', 'n127.0.0.1:5173', 'f24', 'n[::1]:5173',
  'p5000', 'cpostgres', 'f7', 'n*:5432',
  'p6000', 'cbun', 'f9', 'n*:8700',
  'p7000', 'cweird', 'f1', 'nnot-an-address',
].join('\n')

const PROC_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0',
  '   1: 0100007F:9C40 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 999 1 0',
].join('\n')

const PS = ['    1     0', '  100     1', '  200   100', ' 4242   200', ' 5000     1', ' 6000   200'].join('\n')

const ws = (id: string, nodes: Workspace['nodes']): Workspace => ({ id, name: id, cwd: '/w', viewport: { x: 0, y: 0, zoom: 1 }, nodes, bridges: [], updatedAt: 0 })

describe('port parsers', () => {
  it('reads lsof field records, skipping junk addresses', () => {
    expect(parseLsofListening(LSOF)).toEqual([
      { pid: 4242, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 4242, processName: 'node', host: '::1', port: 5173 },
      { pid: 5000, processName: 'postgres', host: '*', port: 5432 },
      { pid: 6000, processName: 'bun', host: '*', port: 8700 },
    ])
  })

  it('reads /proc/net/tcp LISTEN rows only, decoding little-endian addresses', () => {
    expect(parseProcNetTcp(PROC_TCP)).toEqual([{ host: '127.0.0.1', port: 5173, inode: 123456 }])
    expect(parseProcAddress('00000000000000000000000001000000:0050')).toEqual({ host: '::1', port: 80 })
    expect(parseProcAddress('00000000:0000')).toBeNull()
  })

  it('walks the ps parent chain to the nearest PTY root', () => {
    const parents = parsePsParents(PS)
    const roots = new Map([[100, 'sess-a']])
    expect(ownerOf(4242, parents, roots)).toBe('sess-a')
    expect(ownerOf(5000, parents, roots)).toBeUndefined()
    // a cyclic table terminates
    expect(ownerOf(9, new Map([[9, 10], [10, 9]]), roots)).toBeUndefined()
  })

  it('reads tmux pane pids', () => {
    expect(parseTmuxPanes('wt-6e31\t321\nbad\nwt-6e32\tx\n')).toEqual([['wt-6e31', 321]])
  })
})

describe('PortScanner', () => {
  const workspaces = [ws('ws1', [
    { id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'brisk-otter', panes: { dir: 'h', ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1-p2' } } },
    { id: 'n2', kind: 'files', x: 0, y: 0 },
  ])]

  function scanner(over: Partial<PortScanDeps> = {}) {
    const events: AppendEventInput[] = []
    let listeners = parseLsofListening(LSOF)
    const s = new PortScanner({
      listeners: async () => listeners,
      parents: async () => parsePsParents(PS),
      roots: async () => new Map([[200, 'n1-p2']]),
      workspaces: () => workspaces,
      record: (e) => events.push(e),
      selfPort: 8700,
      ...over,
    })
    return { s, events, setListeners: (l: typeof listeners) => { listeners = l } }
  }

  it('maps split panes to their node', () => {
    expect([...paneOwners(workspaces).keys()]).toEqual(['n1', 'n1-p2'])
  })

  it('attributes PTY-descendant listeners to the node, merges v4/v6, drops webterm port and foreign pids', async () => {
    const { s, events } = scanner()
    const ports = await s.scan()
    expect(ports).toEqual([{ port: 5173, host: '127.0.0.1', url: 'http://127.0.0.1:5173', pid: 4242, processName: 'node', nodeId: 'n1', workspaceId: 'ws1', nodeLabel: 'brisk-otter' }])
    expect(events.map((e) => [e.kind, e.nodeId, (e.payload as { port: number }).port])).toEqual([['port.open', 'n1', 5173]])
    expect(s.list('ws1')).toHaveLength(1)
    expect(s.list('other')).toHaveLength(0)
  })

  it('emits port.close when the listener goes away, nothing on an unchanged rescan', async () => {
    const { s, events, setListeners } = scanner()
    await s.scan()
    await s.scan()
    expect(events).toHaveLength(1)
    setListeners([])
    await s.scan()
    expect(events.map((e) => e.kind)).toEqual(['port.open', 'port.close'])
  })

  it('does not run lsof while no PTY is live', async () => {
    let called = false
    const { s } = scanner({ roots: async () => new Map(), listeners: async () => { called = true; return [] } })
    expect(await s.scan()).toEqual([])
    expect(called).toBe(false)
  })

  it('builds browser URLs: wildcard binds open localhost, IPv6 is bracketed', () => {
    expect(portUrl('*', 3000)).toBe('http://localhost:3000')
    expect(portUrl('::', 3000)).toBe('http://localhost:3000')
    expect(portUrl('::1', 3000)).toBe('http://[::1]:3000')
  })

  it('serves the list through GET /api/ports', async () => {
    const { s } = scanner()
    await s.scan()
    const r = await portsRoute('/api/ports', 'GET', new URLSearchParams('workspace=ws1'), async () => s)
    expect(r?.status).toBe(200)
    expect((r?.body as { ports: unknown[] }).ports).toHaveLength(1)
    expect(await portsRoute('/api/other', 'GET', new URLSearchParams(), async () => s)).toBeNull()
    expect((await portsRoute('/api/ports', 'POST', new URLSearchParams(), async () => s))?.status).toBe(405)
  })
})
