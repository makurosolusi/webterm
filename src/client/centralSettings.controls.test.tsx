/** @vitest-environment jsdom */
// LevelChoice (Settings › Central "How much Central may do"): arrow keys never change the level, and the
// confirm dialog of a consequential option opens with Cancel focused so Enter cannot confirm by accident.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LevelChoice } from './centralSettings.controls'

afterEach(cleanup)
const LEVELS = [ // test-only
  { value: 'none', label: 'None' },
  { value: 'workers', label: 'Workers' },
  { value: 'autonomy', label: 'Autonomy', confirm: { title: 'Let it run?', body: 'It acts alone.', action: 'Let it run' } },
] as const

const mount = (onChange = vi.fn()) => {
  render(<LevelChoice id="lvl" label="Level" value="workers" options={LEVELS} onChange={onChange} />)
  return { onChange, radios: within(screen.getByRole('radiogroup', { name: 'Level' })).getAllByRole('radio') }
}

describe('LevelChoice', () => {
  it('arrow keys move focus only: no change, no dialog', () => {
    const { onChange, radios } = mount()
    radios[1]!.focus()
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowLeft', 'End']) fireEvent.keyDown(document.activeElement!, { key })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Enter on Autonomy opens the dialog with Cancel focused; Cancel changes nothing', async () => {
    const { onChange, radios } = mount()
    radios[2]!.focus()
    fireEvent.keyDown(radios[2]!, { key: 'Enter' })
    const dialog = await screen.findByRole('alertdialog', { name: 'Let it run?' })
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the confirm action commits; Space on an option without confirm commits straight away', async () => {
    const { onChange, radios } = mount()
    fireEvent.click(radios[2]!)
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Let it run' }))
    expect(onChange).toHaveBeenLastCalledWith('autonomy')
    fireEvent.keyDown(radios[0]!, { key: ' ' })
    expect(onChange).toHaveBeenLastCalledWith('none')
  })
})
