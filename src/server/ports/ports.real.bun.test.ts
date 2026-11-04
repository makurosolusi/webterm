// Real lsof/proc + ps against a real listener: the scanner finds a port opened by a descendant of a
// "PTY root" (this test process stands in for it) and attributes it to that node.
import { afterAll, expect, test as it } from 'bun:test'
import { spawn } from 'node:child_process'
import type { Workspace } from '../../shared/workspace'
import { listeners, psParents } from './ports.runtime'
import { PortScanner } from './ports.service'

const child = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'inherit'] })
afterAll(() => { child.kill() })

it('detects a listener spawned below a PTY root', async () => {
  const port = Number(await new Promise<string>((r) => child.stdout!.once('data', (d) => r(String(d).trim()))))
  const ws: Workspace = { id: 'ws1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'brisk-otter' }], bridges: [], updatedAt: 0 }
  const kinds: string[] = []
  const scanner = new PortScanner({
    listeners, parents: psParents, roots: async () => new Map([[process.pid, 'n1']]),
    workspaces: () => [ws], record: (e) => kinds.push(e.kind), selfPort: 1,
  })
  const found = await scanner.scan()
  expect(found.find((p) => p.port === port)).toMatchObject({ nodeId: 'n1', workspaceId: 'ws1', nodeLabel: 'brisk-otter', url: `http://127.0.0.1:${port}`, pid: child.pid })
  expect(kinds).toContain('port.open')
}, 20_000)
