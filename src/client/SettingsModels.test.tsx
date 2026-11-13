/** @vitest-environment jsdom */
// Settings › Claude › Models: read-only. One line says models are chosen automatically; the ladder table is
// folded; the per-workspace override editor is gone from Settings (the data is still honoured by the server).
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelsSettings, MODELS_TEXT } from './SettingsModels'

afterEach(cleanup)

describe('Settings › Claude › Models', () => {
  it('says models are automatic and folds the ladder defaults', () => {
    render(<ModelsSettings />)
    expect(screen.getByText(MODELS_TEXT.hint)).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Model ladder defaults' })
    expect((table.closest('details') as HTMLDetailsElement).open).toBe(false)
    expect(within(table).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'ModelEffortUsed for',
      'HaikuLowHelpers and quick exploration',
      'SonnetMediumDefault: Central, routines, reviews, workers',
      'OpusHighPlanners and complex tasks',
      'FableExtra highOnly when you ask for it',
    ])
  })

  it('has no per-workspace model editor and no selects', () => {
    render(<ModelsSettings />)
    expect(screen.queryByText(/Per-workspace model/)).toBeNull()
    expect(screen.queryAllByRole('combobox')).toEqual([])
  })
})
