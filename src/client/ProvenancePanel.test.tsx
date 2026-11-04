/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVENANCE_PATH, ProvenancePanel, type ProvenanceView } from './ProvenancePanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// test-only fixture
const view: ProvenanceView = {
  root: '/r', touched: ['src/a.tsx'], loadedChars: 900, loadedTokens: 225,
  items: [
    { kind: 'house-rules', label: 'webterm house rules', source: '--append-system-prompt-file /d/rules.md', when: 'system-prompt', loaded: true, chars: 800, tokens: 200 },
    { kind: 'rule', label: '.cursor/rules/db.mdc', source: '.cursor/rules/db.mdc', when: 'on-touch', loaded: false, chars: 40, tokens: 10, detail: 'cursor, globs db/**' },
    { kind: 'repo-map', label: 'Repo map', source: 'repo.map tool', when: 'on-demand', loaded: false, chars: 400, tokens: 100, detail: '12 of 30 files' },
  ],
}

describe('What this session loaded', () => {
  it('fetches the node provenance and shows sources, timing, sizes and what is not loaded', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(view)))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProvenancePanel nodeId="node a/1" onClose={() => {}} />)
    expect(await screen.findByText('webterm house rules')).toBeTruthy()
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PROVENANCE_PATH}?nodeId=node%20a%2F1`)
    expect(screen.getByText('In context: about 225 tokens (900 chars)')).toBeTruthy()
    expect(screen.getByText('system prompt')).toBeTruthy()
    expect(screen.getByText('when a matching file is touched')).toBeTruthy()
    expect(screen.getAllByText('not loaded')).toHaveLength(2)
    expect(screen.getByText(/12 of 30 files/)).toBeTruthy()
    expect(screen.getByText('1 touched file decides which glob rules apply.')).toBeTruthy()
  })

  it('shows the server error code instead of an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'node_not_found' }), { status: 404 })))
    render(<ProvenancePanel nodeId="gone" onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot load provenance: node_not_found')
  })
})
