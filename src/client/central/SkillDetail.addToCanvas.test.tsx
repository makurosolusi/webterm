/** @vitest-environment jsdom */
// "Add to canvas" lives ONLY in the skill detail of an active, switched-on canvas skill; it hands the name and the
// active version to the board (cabled to the one selected Claude agent when there is one) and says what happened.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SkillDetail from './SkillDetail'
import { NodeActionsProvider, type NodeActions } from '../nodeActions'
import type { AddSkillResult } from '../skillNode.add'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'

afterEach(cleanup)

const row = (over: { audience?: 'canvas' | 'central'; status?: string; enabled?: boolean } = {}): SkillReviewRow => ({
  record: { name: 'webterm-release', version: '4', sha256: null, status: (over.status ?? 'active') as 'active', origin: 'human', audience: over.audience ?? 'canvas', caps: [], createdAt: 0, proposedBy: null, approvedBy: null, approvedAt: null, evalScore: null, enabled: over.enabled ?? true },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: 'Ship a release.', body: '1. Do it.',
})

function show(r: SkillReviewRow, actions: Partial<NodeActions> | null) {
  const detail = <SkillDetail row={r} client={{} as CentralControlClient} onClose={vi.fn()} onChanged={vi.fn()} />
  render(actions ? <NodeActionsProvider value={{ onSession: () => undefined, onToggleHideLinks: () => undefined, ...actions }}>{detail}</NodeActionsProvider> : detail)
}
const addBtn = () => screen.getByRole('button', { name: 'Add to canvas' }) as HTMLButtonElement

describe('Add to canvas', () => {
  it('adds the skill by name and active version, and says so', () => {
    const addSkillNode = vi.fn((): AddSkillResult => ({ status: 'added' }))
    show(row(), { addSkillNode })
    expect(addBtn().disabled).toBe(false)
    fireEvent.click(addBtn())
    expect(addSkillNode).toHaveBeenCalledWith({ name: 'webterm-release', version: '4' })
    expect(screen.getByText('Added to the canvas.', { exact: false }).getAttribute('role')).toBe('status')
  })

  it.each([
    [{ status: 'attached' }, 'attached to the selected agent'],
    [{ status: 'limit' }, 'already has 8 skills attached'],
    [{ status: 'no_board' }, 'Open a workspace'],
  ] as Array<[AddSkillResult, string]>)('reports %j', (result, text) => {
    show(row(), { addSkillNode: () => result })
    fireEvent.click(addBtn())
    expect(screen.getByText(text, { exact: false }).getAttribute('role')).toBe('status')
  })

  it('is disabled with a reason while the skill is switched off', () => {
    const addSkillNode = vi.fn((): AddSkillResult => ({ status: 'added' }))
    show(row({ enabled: false }), { addSkillNode })
    expect(addBtn().disabled).toBe(true)
    expect(screen.getByText(/Only an active, switched-on canvas skill/)).toBeTruthy()
    fireEvent.click(addBtn())
    expect(addSkillNode).not.toHaveBeenCalled()
  })

  it('is disabled with a reason when no board is open to receive it', () => {
    show(row(), null)
    expect(addBtn().disabled).toBe(true)
    expect(screen.getByText(/Open a workspace to add a skill node/)).toBeTruthy()
  })

  it('does not exist for a central skill or a draft (never a node)', () => {
    show(row({ audience: 'central' }), { addSkillNode: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Add to canvas' })).toBeNull()
    cleanup()
    show(row({ status: 'pending_approval' }), { addSkillNode: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Add to canvas' })).toBeNull()
  })
})
