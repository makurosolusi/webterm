/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_ROUTINE, RoutinesForm, ROUTINE_FORM_TEXT as T } from './RoutinesForm'

afterEach(cleanup)

describe('RoutinesForm prreview action', () => {
  it('makes a PR poll routine for the chosen workspace; save stays off until a workspace is picked', () => {
    const onSave = vi.fn()
    render(<RoutinesForm initial={EMPTY_ROUTINE} workspaces={[{ id: 'ws1', name: 'webterm' }]} onSave={onSave} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Review PRs hourly' } })
    fireEvent.change(screen.getByLabelText('Cron (minute hour day month weekday), e.g. 0 9 * * 1'), { target: { value: '0 * * * *' } })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'prreview' } })
    expect(screen.queryByLabelText('Prompt')).toBeNull()
    expect(screen.getByRole('note').textContent).toBe(T.prreviewNeedsWorkspace)
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws1' } })
    expect(screen.getByRole('note').textContent).toBe(T.prreviewHint)
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Review PRs hourly', workspaceId: 'ws1', trigger: { type: 'schedule', cron: '0 * * * *' }, action: { type: 'prreview' },
    }))
  })

  it('an existing prreview routine opens with the action selected', () => {
    render(<RoutinesForm initial={{ ...EMPTY_ROUTINE, name: 'PRs', workspaceId: 'ws1', action: { type: 'prreview' } }} workspaces={[{ id: 'ws1', name: 'webterm' }]} onSave={() => {}} onCancel={() => {}} />)
    expect((screen.getByLabelText('Action') as HTMLSelectElement).value).toBe('prreview')
    expect(screen.queryByLabelText('Agent node id')).toBeNull()
  })
})
