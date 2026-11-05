/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxPermissions, isPermissionItemId, PERMISSION_PATH } from './InboxPanel.permission'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const pending = [
  { id: 'perm_1', node: 'brisk-otter', label: 'Bash(npm publish)', pattern: 'npm publish', expiresAt: 1 },
  { id: 'perm_2', node: 'calm-owl', label: 'Bash(rm *)', pattern: null, expiresAt: 1 },
]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('InboxPermissions', () => {
  it('renders the request line and posts the chosen decision', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return init?.method === 'POST' ? json({ id: 'perm_1', status: 'approved' }) : json({ items: pending })
    }))
    render(<InboxPermissions pollMs={0} />)
    expect(await screen.findByText('brisk-otter wants to run: Bash(npm publish)')).toBeTruthy()
    // No safe pattern: no "Always allow" on the second row.
    expect(screen.getAllByText('Always allow this pattern')).toHaveLength(1)
    const always = screen.getByRole('button', { name: 'Always allow this pattern' })
    expect(always.hasAttribute('title')).toBe(false)
    expect(tipOf(always)).toBe('Saves a permanent rule: Bash(npm publish)')
    fireEvent.click(screen.getAllByText('Always allow this pattern')[0])
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.init?.method === 'POST')
    expect(post?.url).toBe(PERMISSION_PATH)
    expect(JSON.parse(String(post?.init?.body))).toEqual({ id: 'perm_1', choice: 'always' })
    await waitFor(() => expect(screen.queryByText('brisk-otter wants to run: Bash(npm publish)')).toBeNull())
  })

  it('Deny posts deny; nothing renders when nothing is pending', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return json({}) }
      return json({ items: pending.slice(1) })
    }))
    render(<InboxPermissions pollMs={0} />)
    fireEvent.click(await screen.findByText('Deny'))
    await waitFor(() => expect(bodies).toEqual([{ id: 'perm_2', choice: 'deny' }]))
    await waitFor(() => expect(screen.queryByLabelText('Agent permission requests')).toBeNull())
  })

  it('recognises permission ids', () => {
    expect(isPermissionItemId('perm_ab')).toBe(true)
    expect(isPermissionItemId('task-1')).toBe(false)
  })
})
