/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolEvent } from './agentChatCards.types'
import { diffLines, editDiff, matchCount, readRange, ToolCard, toolSummary } from './toolCards'

afterEach(cleanup)

const tool = (over: Partial<ToolEvent>): ToolEvent => ({ t: 'tool', id: 'tu1', name: 'Bash', input: {}, state: 'running', ...over })
const noLoad = vi.fn(async () => '')
const card = () => document.querySelector('.acc-tool') as HTMLElement

describe('tool helpers', () => {
  it('diffs keep shared head/tail lines as context', () => {
    expect(diffLines('a\nb\nc', 'a\nX\nc')).toEqual([{ k: ' ', t: 'a' }, { k: '-', t: 'b' }, { k: '+', t: 'X' }, { k: ' ', t: 'c' }])
    expect(diffLines('', 'new')).toEqual([{ k: '+', t: 'new' }])
  })

  it('builds Write as all-added and MultiEdit from every edit', () => {
    expect(editDiff('Write', { content: 'x\ny' })).toEqual([{ k: '+', t: 'x' }, { k: '+', t: 'y' }])
    expect(editDiff('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).map((l) => l.k).join('')).toBe('-+-+')
  })

  it('summarizes per tool and survives malformed input', () => {
    expect(toolSummary('Bash', { command: 'ls', description: 'List files' })).toBe('List files')
    expect(toolSummary('Read', { file_path: '/a.ts', offset: 10, limit: 20 })).toBe('/a.ts · lines 10–29')
    expect(toolSummary('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
    expect(toolSummary('Task', { description: 'Find bug' })).toBe('Find bug')
    expect(toolSummary('Edit', null)).toBe('')
    expect(toolSummary('mcp__x__y', { q: 1 })).toBe('{ "q": 1 }')
    expect(readRange({})).toBe('')
  })

  it('counts Grep/Glob matches', () => {
    expect(matchCount('Found 3 files\na\nb\nc')).toBe(3)
    expect(matchCount('a.ts\nb.ts\n')).toBe(2)
    expect(matchCount('No files found')).toBe(0)
  })
})

describe('ToolCard', () => {
  it('Bash shows command, output and a running spinner', () => {
    render(<ToolCard tool={tool({ input: { command: 'echo hi' }, result: 'hi' })} loadFull={noLoad} />)
    expect(screen.getByText('$ echo hi')).toBeTruthy()
    expect(screen.getByLabelText('Tool output').textContent).toBe('hi')
    expect(card().querySelector('.codicon-modifier-spin')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it.each([
    ['error', 'Error'], ['denied', 'Denied'], ['done', 'Done'], ['awaiting_approval', 'Awaiting approval'],
  ] as const)('renders the %s state', (state, label) => {
    render(<ToolCard tool={tool({ state, input: { command: 'x' }, result: 'boom' })} loadFull={noLoad} />)
    expect(card().dataset.state).toBe(state)
    expect(screen.getByText(label)).toBeTruthy()
    const out = screen.getByLabelText('Tool output')
    expect(out.classList.contains('acc-output--error')).toBe(state === 'error' || state === 'denied')
  })

  it('Edit renders a diff with the file path', () => {
    render(<ToolCard tool={tool({ name: 'Edit', state: 'done', input: { file_path: '/src/a.ts', old_string: 'old', new_string: 'new' } })} loadFull={noLoad} />)
    expect(screen.getByText('/src/a.ts')).toBeTruthy()
    expect(screen.getByLabelText('Diff').textContent).toBe('- old+ new')
  })

  it('TodoWrite renders a checklist', () => {
    const todos = [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }]
    render(<ToolCard tool={tool({ name: 'TodoWrite', state: 'done', input: { todos }, result: 'ok' })} loadFull={noLoad} />)
    const items = screen.getByRole('list', { name: 'Todo list' }).querySelectorAll('li')
    expect([...items].map((li) => [li.dataset.status, li.textContent])).toEqual([['completed', 'A'], ['in_progress', 'Doing B']])
    expect(screen.queryByLabelText('Tool output')).toBeNull()
  })

  it('Task shows a subagent header and nests children', () => {
    render(<ToolCard tool={tool({ name: 'Task', input: { description: 'Audit', subagent_type: 'Explore' } })} loadFull={noLoad}><p>child turn</p></ToolCard>)
    expect(screen.getByText('Subagent')).toBeTruthy()
    expect(screen.getByText('Subagent: Explore')).toBeTruthy()
    expect(screen.getByText('child turn')).toBeTruthy()
  })

  it('Grep shows pattern and result count; generic shows JSON input', () => {
    render(<ToolCard tool={tool({ name: 'Grep', state: 'done', input: { pattern: 'foo' }, result: 'Found 2 files\na\nb' })} loadFull={noLoad} />)
    expect(screen.getByText('2 results')).toBeTruthy()
    cleanup()
    render(<ToolCard tool={tool({ name: 'WeirdTool', input: { a: 1 } })} loadFull={noLoad} />)
    expect(card().querySelector('pre')?.textContent).toBe('{\n  "a": 1\n}')
  })

  it('a long result starts collapsed and expands on click', () => {
    render(<ToolCard tool={tool({ state: 'done', input: { command: 'x' }, result: 'l\n'.repeat(50) })} loadFull={noLoad} />)
    const head = screen.getByRole('button', { expanded: false })
    expect(screen.queryByLabelText('Tool output')).toBeNull()
    fireEvent.click(head)
    expect(screen.getByLabelText('Tool output')).toBeTruthy()
  })

  it('truncated output loads the full text, with error + retry', async () => {
    let fail = true
    const loadFull = vi.fn(async (id: string) => {
      if (fail) throw new Error('offline')
      return `full of ${id}`
    })
    render(<ToolCard tool={tool({ state: 'done', input: { command: 'x' }, result: 'cut', truncated: true })} loadFull={loadFull} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }))
    expect(await screen.findByText('Could not load the full output: offline')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('full of tu1')).toBeTruthy()
    expect(loadFull).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /Show full output|Retry/ })).toBeNull()
  })

  it('shows a loading state while the full output is fetched', async () => {
    let finish: (s: string) => void = () => undefined
    const loadFull = vi.fn(() => new Promise<string>((r) => { finish = r }))
    render(<ToolCard tool={tool({ state: 'done', result: 'cut', truncated: true })} loadFull={loadFull} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }))
    const btn = screen.getByRole('button', { name: /Loading full output/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    finish('done text')
    expect(await screen.findByText('done text')).toBeTruthy()
  })
})
