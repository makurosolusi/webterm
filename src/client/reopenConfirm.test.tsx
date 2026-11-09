/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { answerReopen, confirmReopen, reopenCopy, ReopenConfirmHost } from './reopenConfirm'
import type { ClosedEntry } from './closedHistory'

// test-only fixture: a closed shell of workspace "proj".
const entry: ClosedEntry = {
  node: { id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'shell' },
  workspaceId: 'w1', workspaceName: 'proj', closedAt: 0,
}

afterEach(() => { act(() => answerReopen(false)); cleanup() })

/** Opens the host and one request; returns the request's answer. */
function ask(active?: string | null): Promise<boolean> {
  render(<ReopenConfirmHost />)
  let p!: Promise<boolean>
  act(() => { p = confirmReopen(entry, active) })
  return p
}

describe('reopenCopy', () => {
  it('names the session and says it opens on this board when its workspace is active', () => {
    expect(reopenCopy(entry, 'w1')).toEqual({ title: 'Reopen “shell”?', body: 'It opens again on this board.' })
  })
  it('says webterm switches workspace when it belongs to another one (or none is open)', () => {
    const body = 'It opens again in workspace proj, and webterm switches to that workspace.'
    expect(reopenCopy(entry, 'w2').body).toBe(body)
    expect(reopenCopy(entry, null).body).toBe(body)
  })
  it('only names the workspace when the caller does not know the active one', () => {
    expect(reopenCopy(entry).body).toBe('It opens again in workspace proj.')
  })
})

describe('ReopenConfirmHost', () => {
  it('renders nothing until asked', () => {
    render(<ReopenConfirmHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves true on Reopen, which has focus', async () => {
    const p = ask('w2')
    expect(screen.getByText('Reopen “shell”?')).toBeTruthy()
    expect(screen.getByText(/webterm switches to that workspace/)).toBeTruthy()
    const reopen = screen.getByRole('button', { name: 'Reopen' })
    expect(document.activeElement).toBe(reopen)
    fireEvent.click(reopen)
    await expect(p).resolves.toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves false on Cancel', async () => {
    const p = ask('w1')
    expect(screen.getByText('It opens again on this board.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(p).resolves.toBe(false)
  })

  it('resolves false on Escape', async () => {
    const p = ask()
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(p).resolves.toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves false when the host unmounts', async () => {
    const p = ask()
    cleanup()
    await expect(p).resolves.toBe(false)
  })

  it('a second request replaces the first, which resolves false', async () => {
    const first = ask()
    let second!: Promise<boolean>
    act(() => { second = confirmReopen({ ...entry, node: { ...entry.node, title: 'other' } }) })
    await expect(first).resolves.toBe(false)
    expect(screen.getByText('Reopen “other”?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await expect(second).resolves.toBe(true)
  })
})
