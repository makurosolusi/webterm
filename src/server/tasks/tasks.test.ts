import { TEST_UI_COOKIE } from '../uiSession.testutil'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import type { AppendEventInput } from '../events/eventModel'
import { listTasks, packageManager, type TaskFs } from './tasks.list'
import { tasksRoute } from './tasks.route'

// test-only: an in-memory workspace folder; YAML pre-parsed (Bun.YAML is not in vitest).
function memFs(files: Record<string, string>, yaml: Record<string, unknown> = {}): TaskFs {
  return {
    read: async (p) => files[p] ?? null,
    exists: async (p) => p in files,
    parseYaml: (text) => { if (!(text in yaml)) throw new Error('bad yaml'); return yaml[text] },
  }
}

const PKG = JSON.stringify({ scripts: { dev: 'vite', 'test:unit': 'vitest run', 'bad name;rm': 'x', empty: '' } })

describe('listTasks', () => {
  it('lists package.json scripts run through the lockfile package manager', async () => {
    const tasks = await listTasks('/w', memFs({ '/w/package.json': PKG, '/w/bun.lock': '' }))
    expect(tasks).toEqual([
      { id: 'package.json:dev', name: 'dev', source: 'package.json', detail: 'vite', run: 'bun run dev' },
      { id: 'package.json:test:unit', name: 'test:unit', source: 'package.json', detail: 'vitest run', run: 'bun run test:unit' },
    ])
  })

  it('detects pnpm, yarn, npm', async () => {
    expect(await packageManager('/w', memFs({ '/w/pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(await packageManager('/w', memFs({ '/w/yarn.lock': '' }))).toBe('yarn')
    expect(await packageManager('/w', memFs({}))).toBe('npm')
  })

  it('adds webterm.yaml scripts and defaultTabs commands; webterm.yaml wins over orca.yaml', async () => {
    const fs = memFs(
      { '/w/webterm.yaml': 'W', '/w/orca.yaml': 'O', '/w/package.json': PKG },
      { W: { scripts: { setup: 'pnpm install\n', lint: 42 }, defaultTabs: [{ title: 'Git', command: 'git status' }, { title: 'Agent' }] }, O: { scripts: { other: 'x' } } },
    )
    const tasks = await listTasks('/w', fs)
    expect(tasks.slice(0, 2)).toEqual([
      { id: 'webterm.yaml:setup', name: 'setup', source: 'webterm.yaml', detail: 'pnpm install', run: 'pnpm install' },
      { id: 'webterm.yaml:tab:Git', name: 'Git', source: 'webterm.yaml', detail: 'git status', run: 'git status' },
    ])
    expect(tasks.some((t) => t.name === 'other')).toBe(false)
    expect(tasks.filter((t) => t.source === 'package.json')).toHaveLength(2)
  })

  it('ignores invalid YAML and broken package.json', async () => {
    expect(await listTasks('/w', memFs({ '/w/orca.yaml': 'broken', '/w/package.json': '{' }))).toEqual([])
  })
})

const HOST = '127.0.0.1:8700'
const BROWSER = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
const ws: Workspace = { id: 'ws1', name: 'w', cwd: '/w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 }

describe('tasksRoute', () => {
  function route(liveAfter = 0) {
    const typed: Array<[string, string]> = []
    const events: AppendEventInput[] = []
    let polls = 0
    const deps = {
      workspace: async (id: string) => (id === 'ws1' ? ws : null),
      sessions: async () => ({ isLive: () => polls++ >= liveAfter, input: (id: string, d: string) => { typed.push([id, d]) } }),
      record: (e: AppendEventInput) => events.push(e),
      fs: memFs({ '/w/package.json': PKG }),
      isNodeToken: (t: string) => t === 'node-token',
      sleep: async () => {},
      waitMs: 300,
    }
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = BROWSER) =>
      tasksRoute({ method, headers } as unknown as IncomingMessage, new URL(`http://${HOST}${path}`), async () => JSON.stringify(body), deps)
    return { call, typed, events }
  }

  it('lists tasks of the workspace folder', async () => {
    const { call } = route()
    expect(((await call('GET', '/api/tasks?workspace=ws1'))?.body as { tasks: unknown[] }).tasks).toHaveLength(2)
    expect((await call('GET', '/api/tasks?workspace=none'))?.body).toEqual({ tasks: [] })
  })

  it('types the looked-up line once the terminal is live and records task.run', async () => {
    const { call, typed, events } = route(3)
    const r = await call('POST', '/api/tasks/run', { workspace: 'ws1', task: 'package.json:dev', node: 'n-task' })
    expect(r?.status).toBe(202)
    expect(typed).toEqual([['n-task', 'npm run dev\r']])
    expect(events[0]).toMatchObject({ kind: 'task.run', nodeId: 'n-task', payload: { task: 'dev', source: 'package.json' } })
  })

  it('refuses agents, unknown tasks and a terminal that never starts', async () => {
    const { call, typed } = route(1000)
    expect((await call('POST', '/api/tasks/run', { workspace: 'ws1', task: 'package.json:dev', node: 'n' }, { ...BROWSER, 'x-webterm-token': 'node-token' }))?.status).toBe(403)
    expect((await call('POST', '/api/tasks/run', { workspace: 'ws1', task: 'rm -rf /', node: 'n' }))?.status).toBe(404)
    expect((await call('POST', '/api/tasks/run', { workspace: 'ws1', task: 'package.json:dev', node: 'n' }))?.status).toBe(504)
    expect(typed).toEqual([])
  })
})
