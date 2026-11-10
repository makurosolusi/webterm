/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setSideBar } from '../secondarySideBar.store'
import { CentralContextMeter, contextLevel } from './centralContextMeter'
import type { ContextView } from './centralControlTypes'

afterEach(() => { cleanup(); act(() => setSideBar({ open: false, view: 'chat' })) })

// test-only
const view = (over: Partial<ContextView> = {}): ContextView => ({ tokens: 54_000, window: 128_000, percent: 42, lastCompaction: null, ...over })
const mount = (load: () => Promise<ContextView>, refreshKey = 0, conversationId = 'c1') => <TooltipProvider><CentralContextMeter conversationId={conversationId} refreshKey={refreshKey} load={load} /></TooltipProvider>

describe('context meter', () => {
  it.each([[69, 'ok'], [70, 'warn'], [84, 'warn'], [85, 'danger'], [100, 'danger']] as const)('%i%% is %s', (percent, level) => {
    expect(contextLevel(percent)).toBe(level)
  })

  it('shows the percentage with tokens and compaction in its accessible name and colours by level', async () => {
    render(mount(async () => view({ percent: 72 })))
    const button = await screen.findByRole('button', { name: /Context 72%. 54K of 128K tokens in context. Not compacted yet/ })
    expect(button.getAttribute('data-level')).toBe('warn')
  })

  it('renders nothing without data', async () => {
    const load = vi.fn(async () => view({ tokens: null, percent: null }))
    const { container } = render(mount(load))
    await waitFor(() => expect(load).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toBe('')
  })

  it('stays hidden when the first load fails', async () => {
    const load = vi.fn(async () => { throw new Error('down') })
    const { container } = render(mount(load))
    await waitFor(() => expect(load).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toBe('')
  })

  it('reloads when a turn settles, not on an unrelated render', async () => {
    const load = vi.fn(async () => view())
    const { rerender } = render(mount(load, 1))
    await screen.findByText('Context 42%')
    rerender(mount(load, 1))
    expect(load).toHaveBeenCalledTimes(1)
    rerender(mount(load, 2))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('reloads when the chat comes back into view', async () => {
    act(() => setSideBar({ open: true, view: 'central' }))
    const load = vi.fn(async () => view())
    render(mount(load))
    await screen.findByText('Context 42%')
    act(() => setSideBar({ open: true, view: 'chat' }))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('clicking shows the last compaction summary', async () => {
    render(mount(async () => view({ lastCompaction: { at: Date.now(), trigger: 'auto', preTokens: 100_000, summary: 'Kept the open tasks.' } })))
    fireEvent.click(await screen.findByRole('button', { name: /Last compacted just now/ }))
    expect(await screen.findByText('Kept the open tasks.')).toBeTruthy()
  })

  it('says when a compaction left no summary', async () => {
    render(mount(async () => view({ lastCompaction: { at: Date.now(), trigger: 'auto', preTokens: 1, summary: null } })))
    fireEvent.click(await screen.findByRole('button', { name: /Context 42%/ }))
    expect(await screen.findByText('No summary was saved for this compaction.')).toBeTruthy()
  })
})
