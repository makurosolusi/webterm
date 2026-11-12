/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineEvent } from './Timeline.model'
import { TimelinePanel } from './Timeline.panel'

// test-only fixtures
const ev = (seq: number, kind: string, payload: Record<string, unknown>): TimelineEvent => ({
  seq, ts: 1000 + seq, kind, source: 'test', actor: 'test', subject: null, workspaceId: 'w1', nodeId: 'n1',
  trust: 'trusted', dedupeKey: null, payload, prevHash: '', hash: '', })
const EVENTS = [
  ev(1, 'hook.PreToolUse', { toolName: 'Read', input: 'a.md' }),
  ev(2, 'permission.decision', { tool: 'Bash', label: 'Bash(ls)', behavior: 'allow', by: 'human-ui' }),
  ev(3, 'hook.PreToolUse', { toolName: 'Bash', input: 'rm -rf dist', mode: 'danger' }),
]
vi.mock('./Timeline.stream', () => ({
  useTimelineFeed: () => ({ events: EVENTS, epoch: 0, connection: 'open', error: null, more: false, loadingOlder: false, loadOlder: async () => undefined }),
}))
vi.mock('./Timeline.status', async (orig) => ({
  ...(await orig<typeof import('./Timeline.status')>()),
  useTimelineStatus: () => ({ control: null, integrity: { state: 'unknown' } }),
}))
afterEach(cleanup)

it('the Permissions filter shows only permission lines; Danger tool lines carry the warning tone', () => {
  render(<TimelinePanel workspaces={[]} onFocusNode={() => undefined} />)
  const danger = screen.getByText(/skipped asking \(Danger\): Bash rm -rf dist/)
  expect(danger.closest('li')?.getAttribute('data-tone')).toBe('warning')
  expect(screen.getByText(/is running Read a\.md/)).not.toBeNull()
  fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'permissions' } })
  expect(screen.getByText('Approved by you: Bash(ls)')).not.toBeNull()
  expect(screen.queryByText(/is running Read/)).toBeNull()
  expect(screen.queryByText(/skipped asking/)).toBeNull()
})
