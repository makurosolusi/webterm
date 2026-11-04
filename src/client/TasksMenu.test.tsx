/** @vitest-environment jsdom */
// Run Task: the status item lists tasks in a quick pick; picking one adds a terminal node and asks
// the server to type the task into it. fetch is faked.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { WorkspaceTask } from '../server/tasks/tasks.list'
import { taskPickItems, useTasksMenu } from './TasksMenu'

const TASKS: WorkspaceTask[] = [
  { id: 'package.json:dev', name: 'dev', source: 'package.json', detail: 'vite', run: 'bun run dev' },
  { id: 'orca.yaml:setup', name: 'setup', source: 'orca.yaml', detail: 'pnpm install\nmore', run: 'pnpm install\nmore' },
]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

let open: () => void = () => {}
function Harness({ add }: { add: (...a: unknown[]) => void }) {
  const t = useTasksMenu('ws1', add)
  open = t.statusItems[0]!.onClick!
  return <>{t.statusItems[0]!.label}{t.menu}</>
}

describe('TasksMenu', () => {
  it('quick pick rows show the source and the first line of the script', () => {
    expect(taskPickItems(TASKS)[1]).toMatchObject({ id: 'orca.yaml:setup', label: 'setup', description: 'orca.yaml', detail: 'pnpm install' })
  })

  it('picking a task opens a terminal node and runs it there', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(url.startsWith('/api/tasks/run') ? {} : { tasks: TASKS }), { status: url.startsWith('/api/tasks/run') ? 202 : 200 })
    }))
    const add = vi.fn()
    render(<Harness add={add} />)
    act(() => open())
    fireEvent.click(await screen.findByText('dev'))
    const node = (add.mock.calls[0]![0] as (n: number, ws: { cwd: string }) => { id: string; kind: string; cwd: string; title: string })(0, { cwd: '/w' })
    expect(node).toMatchObject({ kind: 'terminal', cwd: '/w', title: 'dev' })
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/tasks/run'))).toBe(true))
    expect(calls.find((c) => c.url.startsWith('/api/tasks/run'))!.body).toEqual({ workspace: 'ws1', task: 'package.json:dev', node: node.id })
  })

  it('a failed run shows on the status item', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.startsWith('/api/tasks/run')
        ? new Response(JSON.stringify({ message: 'The task terminal did not start in time.' }), { status: 504 })
        : new Response(JSON.stringify({ tasks: TASKS }))))
    render(<Harness add={() => {}} />)
    act(() => open())
    fireEvent.click(await screen.findByText('dev'))
    expect(await screen.findByText('Task failed')).toBeTruthy()
  })
})
