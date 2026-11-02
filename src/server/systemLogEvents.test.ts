// Kejadian log inti (pty/agent/workspace/fs/settings/env) tercatat di `logBus` dengan tag stabil,
// dan TIDAK membawa isi terminal, nilai env/secret, atau path penuh.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '../shared/logEntry'
import type { ServerMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Db } from './db'
import { fsApiRoute } from './fsApi'
import { FakePty } from './fakePty.testutil'
import { configureLogging, getLogLevel, logBus, setLogLevel } from './logs'
import { Sessions } from './sessions'
import { setupEnv } from './envSettings.testutil'
import { workspacesRoute } from './workspacesApi'

let prevLevel = getLogLevel()
beforeAll(() => {
  prevLevel = getLogLevel()
  setLogLevel('trace')
  configureLogging({ console: false, env: { WEBTERM_LOG_FILE: 'off' } })
})
afterAll(() => {
  setLogLevel(prevLevel)
  configureLogging({ console: true, env: { WEBTERM_LOG_FILE: 'off' } })
})
beforeEach(() => logBus.clear())

const events = (): LogEntry[] => logBus.snapshot()
const find = (event: string): LogEntry | undefined => events().find((e) => e.event === event)
const all = (event: string): LogEntry[] => events().filter((e) => e.event === event)
/** Seluruh log sebagai satu string: dipakai untuk membuktikan sesuatu TIDAK bocor. */
const dump = (): string => JSON.stringify(events())

function harness(shell?: string) {
  const ptys: FakePty[] = []
  let t = 1_000
  const sessions = new Sessions({
    shell,
    spawn: () => { const p = new FakePty(4242 + ptys.length); ptys.push(p); return p },
    now: () => t,
  })
  return { sessions, ptys, tick: (ms: number) => { t += ms } }
}
const noop = (_m: ServerMsg): void => {}

describe('sesi PTY dan agent', () => {
  it('open mencatat pty.spawn tanpa cwd penuh, baris perintah, atau isi terminal', () => {
    const { sessions, ptys } = harness('/usr/local/bin/zsh')
    sessions.open({ t: 'open', id: 'n1', cols: 100, rows: 30, cwd: '/Users/secretname/project', cmd: 'echo TOPSECRETCMD' }, noop)
    ptys[0].emitData('TERMINAL-OUTPUT-SENTINEL')
    sessions.input('n1', 'TYPED-INPUT-SENTINEL')
    const e = find('pty.spawn')
    expect(e).toMatchObject({ channel: 'pty', level: 'info', ids: { nodeId: 'n1' }, data: { pid: 4242, shell: 'zsh', cols: 100, rows: 30, cwd: 'project' } })
    expect(dump()).not.toMatch(/secretname|TOPSECRETCMD|TERMINAL-OUTPUT-SENTINEL|TYPED-INPUT-SENTINEL/)
    expect(find('agent.spawn')).toBeUndefined()
  })

  it('agent: spawn, transisi status (bukan pengulangan), dan exit dengan durasi', () => {
    const { sessions, ptys, tick } = harness()
    sessions.open({ t: 'open', id: 'a1', cols: 80, rows: 24, agentId: 'claude' }, noop)
    expect(find('agent.spawn')).toMatchObject({ channel: 'agent', ids: { nodeId: 'a1' }, data: { agentId: 'claude' } })
    sessions.setStatus('a1', 'working')
    sessions.setStatus('a1', 'working')
    sessions.setStatus('a1', 'waiting')
    expect(all('agent.status').map((x) => x.data)).toEqual([
      { from: undefined, to: 'working' }, { from: 'working', to: 'waiting' },
    ].map((d) => ({ ...d })).map((d) => (d.from === undefined ? { to: d.to } : d)))
    tick(2500)
    ptys[0].emitExit(7)
    expect(find('pty.exit')).toMatchObject({ level: 'info', ids: { nodeId: 'a1' }, data: { code: 7, reason: 'self', durationMs: 2500 } })
    expect(find('agent.exit')).toMatchObject({ data: { agentId: 'claude', code: 7 } })
  })

  it('close mencatat pty.exit reason=closed; resize hanya trace; re-attach tidak spawn lagi', () => {
    const { sessions } = harness()
    sessions.open({ t: 'open', id: 'n2', cols: 80, rows: 24 }, noop)
    sessions.open({ t: 'open', id: 'n2', cols: 80, rows: 24 }, noop)
    sessions.resize('n2', 120, 40)
    sessions.resize('ghost', 1, 1)
    sessions.close('n2')
    expect(all('pty.spawn')).toHaveLength(1)
    expect(find('pty.attach')?.level).toBe('debug')
    expect(all('pty.resize')).toHaveLength(1)
    expect(find('pty.resize')).toMatchObject({ level: 'trace', data: { cols: 120, rows: 40 } })
    expect(find('pty.exit')).toMatchObject({ data: { code: -1, reason: 'closed' } })
  })

  it('id tidak aman ditolak tanpa log spawn', () => {
    const { sessions } = harness()
    sessions.open({ t: 'open', id: '../evil', cols: 80, rows: 24 }, noop)
    expect(all('pty.spawn')).toHaveLength(0)
  })
})

function fakeStore(failSave = false): Db {
  const rows = new Map<string, Workspace>()
  return {
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id) ?? null,
    create: (name: string, cwd?: string) => {
      const ws: Workspace = { id: 'ws1', name, cwd, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 1 }
      rows.set(ws.id, ws)
      return ws
    },
    save: (ws: Workspace) => { if (failSave) throw Object.assign(new Error('disk full at /Users/x'), { code: 'SQLITE_FULL' }); rows.set(ws.id, ws) },
    delete: (id: string) => void rows.delete(id),
    getActive: () => null,
    setActive: () => {},
  } as unknown as Db
}

describe('workspace dan node', () => {
  const body = (v: unknown) => async () => JSON.stringify(v)
  const node = (id: string) => ({ id, kind: 'terminal', x: 0, y: 0 })

  it('create, rename, node.create/delete, layout.save, delete', async () => {
    const store = fakeStore()
    await workspacesRoute(store, '/api/workspaces', 'POST', body({ name: 'MyPrivateName', cwd: '/Users/secretname/proj' }))
    expect(find('workspace.create')).toMatchObject({ channel: 'workspace', ids: { workspaceId: 'ws1' }, data: { cwd: 'proj' } })

    const save = (name: string, nodes: unknown[], zoom = 1) =>
      workspacesRoute(store, '/api/workspaces/ws1', 'PUT', body({ name, viewport: { x: 0, y: 0, zoom }, nodes }))
    await save('MyPrivateName', [node('n1')])
    await save('Renamed', [node('n2')], 2)
    expect(find('workspace.rename')?.ids).toEqual({ workspaceId: 'ws1' })
    expect(all('node.create').map((e) => e.ids?.nodeId)).toEqual(['n1', 'n2'])
    expect(all('node.delete').map((e) => e.ids?.nodeId)).toEqual(['n1'])
    expect(all('layout.save')).toHaveLength(1)
    expect(all('workspace.save')).toHaveLength(2)

    await workspacesRoute(store, '/api/workspaces/ws1', 'DELETE', body({}))
    expect(find('workspace.delete')?.ids).toEqual({ workspaceId: 'ws1' })
    expect(dump()).not.toMatch(/MyPrivateName|Renamed|secretname/)
  })

  it('kegagalan simpan DB dicatat sebagai error lalu dilempar ulang', async () => {
    const store = fakeStore(true)
    await expect(workspacesRoute(store, '/api/workspaces/ws9', 'PUT', body({ name: 'x', viewport: DEFAULT_VIEWPORT, nodes: [] }))).rejects.toThrow('disk full')
    expect(find('workspace.db.error')).toMatchObject({ level: 'error', data: { error: 'Error', code: 'SQLITE_FULL' } })
    expect(dump()).not.toContain('/Users/x')
  })
})

describe('fs', () => {
  let dir = ''
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'wt-fslog-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('read/write/mkdir debug (basename saja) dan fs.error bila gagal', async () => {
    const file = join(dir, 'note.txt')
    await fsApiRoute('/api/fs/write', 'POST', new URLSearchParams(), async () => JSON.stringify({ path: file, content: 'FILE-CONTENT-SENTINEL' }))
    await fsApiRoute('/api/fs/read', 'GET', new URLSearchParams({ path: file }), async () => '')
    await fsApiRoute('/api/fs/mkdir', 'POST', new URLSearchParams(), async () => JSON.stringify({ path: join(dir, 'sub') }))
    expect(find('fs.write')).toMatchObject({ level: 'debug', data: { file: 'note.txt', ok: true, chars: 21 } })
    expect(find('fs.read')).toMatchObject({ data: { file: 'note.txt' } })
    expect(find('fs.mkdir')?.data).toMatchObject({ file: 'sub', ok: true })

    await fsApiRoute('/api/fs/read', 'GET', new URLSearchParams({ path: join(dir, 'missing.txt') }), async () => '').catch(() => undefined)
    await writeFile(join(dir, 'f'), 'x')
    await fsApiRoute('/api/fs/write', 'POST', new URLSearchParams(), async () => JSON.stringify({ path: join(dir, 'f', 'child'), content: 'x' }))
    const errors = all('fs.error')
    expect(errors.map((e) => e.data)).toEqual([
      { op: 'read', file: 'missing.txt', code: 'ENOENT' },
      { op: 'write', file: 'child', code: 'ENOTDIR' },
    ])
    expect(errors.every((e) => e.level === 'warn')).toBe(true)
    expect(dump()).not.toMatch(/FILE-CONTENT-SENTINEL/)
    expect(dump()).not.toContain(dir)
  })
})

describe('env settings', () => {
  it('env.override.set/clear mencatat NAMA kunci saja, tidak pernah nilai', () => {
    const s = setupEnv()
    const SECRET_VALUE = 'SentinelWebhookSecret_0123456789abcdef'
    s.svc.update({ set: { WEBTERM_LEDGER: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET_VALUE }, unset: [] }, { root: true })
    s.svc.update({ set: {}, unset: ['WEBTERM_LEDGER'] }, { root: true })
    expect(all('env.override.set').map((e) => e.data?.name)).toContain('WEBTERM_LEDGER')
    expect(all('env.override.clear').map((e) => e.data?.name)).toEqual(['WEBTERM_LEDGER'])
    expect(dump()).not.toContain(SECRET_VALUE)
    expect(dump()).not.toContain('"on"')
  })

  it('env.locked dicatat bila saklar off dan update ditolak', () => {
    const s = setupEnv({ WEBTERM_ENV_SETTINGS: 'off' })
    expect(find('env.locked')).toBeDefined()
    logBus.clear()
    expect(s.svc.update({ set: { WEBTERM_LEDGER: 'on' }, unset: [] }, { root: true }).ok).toBe(false)
    expect(find('env.locked')?.level).toBe('warn')
  })
})
