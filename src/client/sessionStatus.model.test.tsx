/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { BUCKET_ORDER, sessionStatusView, UNREAD_LABEL } from './sessionStatus.model'
import { SessionStatusGlyph } from './SessionStatusGlyph'
import { nodeTabSignal } from './sessionSignal'

describe('sessionStatusView', () => {
  it('orders buckets by lifecycle: needs input, working, idle, error, exited', () => {
    expect(BUCKET_ORDER).toEqual(['needs-input', 'working', 'idle', 'error', 'exited'])
  })

  it('blocked needs you, with the tool it waits on', () => {
    const v = sessionStatusView({ status: 'blocked', reason: 'permission', detail: 'Bash' })
    expect(v).toMatchObject({ bucket: 'needs-input', tone: 'attention', icon: 'bell', chip: 'Needs you', label: 'Waiting for approval: Bash' })
    expect(sessionStatusView({ status: 'blocked' }).label).toBe('Waiting for your approval')
  })

  it('a question needs you; a plain turn end is calm idle, not attention', () => {
    expect(sessionStatusView({ status: 'waiting', reason: 'question' })).toMatchObject({ bucket: 'needs-input', label: 'Asked a question' })
    expect(sessionStatusView({ status: 'waiting' })).toMatchObject({ bucket: 'idle', tone: 'idle', icon: null, chip: 'Turn ended', label: 'Turn ended' })
  })

  it('failed and a failed turn are Error, never attention', () => {
    expect(sessionStatusView({ status: 'failed' })).toMatchObject({ bucket: 'error', tone: 'error', chip: 'Failed', label: 'Failed' })
    expect(sessionStatusView({ status: 'failed', reason: 'error', detail: 'error_max_turns' }).label).toBe('Error: error_max_turns')
    expect(sessionStatusView({ status: 'waiting', reason: 'error' })).toMatchObject({ bucket: 'error', label: 'Turn failed' })
  })

  it('working spins; stopped and done are exited', () => {
    expect(sessionStatusView({ status: 'working' })).toMatchObject({ bucket: 'working', icon: 'loading', chip: 'Working' })
    expect(sessionStatusView({ status: 'stopped' })).toMatchObject({ bucket: 'exited', chip: 'Stopped' })
    expect(sessionStatusView({ status: 'done', exit: { code: 0 } })).toMatchObject({ bucket: 'exited', chip: 'Exited', label: 'Exited (code 0)' })
  })

  it('no status is never "unknown": live at its prompt reads Ready, an exit reads Exited', () => {
    expect(sessionStatusView({})).toMatchObject({ bucket: 'idle', chip: 'Ready', icon: null })
    expect(sessionStatusView({ exit: { code: 2 } })).toMatchObject({ bucket: 'exited', label: 'Exited (code 2)' })
    expect(sessionStatusView({ starting: true })).toMatchObject({ bucket: 'working', chip: 'Starting…' })
    // A hook status wins over the spawn flag.
    expect(sessionStatusView({ starting: true, status: 'blocked' }).bucket).toBe('needs-input')
  })

  it('unread flags Idle only, and keeps the bucket', () => {
    expect(sessionStatusView({ status: 'waiting', unread: true })).toMatchObject({ bucket: 'idle', tone: 'unread', unread: true, label: `Turn ended — ${UNREAD_LABEL}` })
    expect(sessionStatusView({ status: 'blocked', unread: true })).toMatchObject({ tone: 'attention', unread: false })
    expect(sessionStatusView({ status: 'working', unread: true }).unread).toBe(false)
  })

  it('passes statusSince through', () => {
    expect(sessionStatusView({ status: 'working', since: 42 }).since).toBe(42)
  })
})

describe('SessionStatusGlyph', () => {
  it('renders a labelled icon, spinning while working', () => {
    const { getByRole } = render(<SessionStatusGlyph view={sessionStatusView({ status: 'working' })} />)
    expect(getByRole('img', { name: 'Working' }).querySelector('.codicon-loading.codicon-modifier-spin')).toBeTruthy()
  })

  it('renders nothing for a calm view', () => {
    const { container } = render(<SessionStatusGlyph view={sessionStatusView({ status: 'waiting' })} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('nodeTabSignal', () => {
  it('reads the model: error has its own tone, calm turn end has no dot', () => {
    expect(nodeTabSignal('agent', 'failed', false)).toEqual({ tone: 'error', label: 'Failed' })
    expect(nodeTabSignal('agentChat', 'waiting', false)).toBeUndefined()
    expect(nodeTabSignal('agent', 'blocked', false, { reason: 'permission', detail: 'Edit' })).toEqual({ tone: 'attention', label: 'Waiting for approval: Edit' })
    expect(nodeTabSignal('terminal', 'working', false)).toBeUndefined()
  })
})
