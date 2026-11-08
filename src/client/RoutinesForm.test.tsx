/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_ROUTINE, RoutinesForm, ROUTINE_FORM_TEXT as T } from './RoutinesForm'
import { ROUTINE_SCHEDULE_PRESETS } from './routineSchedule.presets'

afterEach(cleanup)

describe('RoutinesForm', () => {
  it('makes a PR poll routine for the chosen workspace; save stays off until a workspace is picked', () => {
    const onSave = vi.fn()
    render(<RoutinesForm initial={EMPTY_ROUTINE} workspaces={[{ id: 'ws1', name: 'webterm' }]} onSave={onSave} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Review PRs hourly' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '0 * * * *' } })
    fireEvent.blur(screen.getByLabelText('Schedule'))
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

  it('schedule presets map to cron; a custom cron is checked before it is kept', () => {
    const onSave = vi.fn()
    render(<RoutinesForm initial={{ ...EMPTY_ROUTINE, name: 'n' }} workspaces={[]} onSave={onSave} onCancel={() => {}} />)
    const schedule = screen.getByLabelText('Schedule') as HTMLInputElement
    fireEvent.click(screen.getAllByRole('button', { name: 'Show suggestions' })[0]!)
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(ROUTINE_SCHEDULE_PRESETS.map((p) => `${p.label}${p.value}`))
    fireEvent.click(screen.getByRole('option', { name: /^Weekdays at 9:00/ }))
    expect(schedule.value).toBe('0 9 * * 1-5')
    fireEvent.change(schedule, { target: { value: '99 * * * *' } })
    fireEvent.blur(schedule)
    expect(screen.getByRole('alert').textContent).toMatch(/minute out of range/)
    fireEvent.change(schedule, { target: { value: '30 8 * * 1-5' } })
    fireEvent.blur(schedule)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ trigger: { type: 'schedule', cron: '30 8 * * 1-5' } }))
  })

  it('check command, limits and timeouts sit under a closed More options, in plain words', () => {
    const onSave = vi.fn()
    render(<RoutinesForm initial={{ ...EMPTY_ROUTINE, name: 'n' }} workspaces={[]} onSave={onSave} onCancel={() => {}} />)
    const more = screen.getByTestId('routine-more') as HTMLDetailsElement
    expect(more.open).toBe(false)
    expect(more.querySelector('summary')?.textContent).toBe(T.more)
    const check = screen.getByLabelText(T.precheck)
    expect(more.contains(check)).toBe(true)
    expect(more.contains(screen.getByLabelText(T.maxRuns))).toBe(true)
    expect(more.contains(screen.getByLabelText(T.maxCost))).toBe(true)
    expect(screen.queryByLabelText(T.precheckTimeout)).toBeNull() // only once there is a command
    fireEvent.change(check, { target: { value: 'git diff --quiet' } })
    fireEvent.change(screen.getByLabelText(T.precheckTimeout), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText(T.maxRuns), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(T.maxCost), { target: { value: '2.5' } })
    fireEvent.blur(screen.getByLabelText(T.maxCost))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      precheck: { command: 'git diff --quiet', timeoutSeconds: 30 }, budget: { maxRunsPerDay: 4, maxCostUsdPerDay: 2.5 },
    }))
    expect(document.body.textContent).not.toMatch(/non-zero|precheck/i)
  })

  it('an existing prreview routine opens with the action selected', () => {
    render(<RoutinesForm initial={{ ...EMPTY_ROUTINE, name: 'PRs', workspaceId: 'ws1', action: { type: 'prreview' } }} workspaces={[{ id: 'ws1', name: 'webterm' }]} onSave={() => {}} onCancel={() => {}} />)
    expect((screen.getByLabelText('Action') as HTMLSelectElement).value).toBe('prreview')
    expect(screen.queryByLabelText('Agent node id')).toBeNull()
  })
})
