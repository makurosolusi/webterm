/** @vitest-environment jsdom */
// Wizard step "Commands": optional (Skip / Continue write nothing themselves), shows the shared panel, and
// a step added after an install finished never brings the wizard back for that install.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySettingsPatch } from '../../shared/settings.patch'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/settings'
import { SETUP_STEPS, normalizeSetup, type SetupState } from '../../shared/settings.setup'
import { backfillSetup } from '../../server/setupBackfill'
import { COMMANDS_TEXT } from '../customCommands/commands.labels'
import { fakeCommands } from '../customCommands/commands.fakeServer'
import { SetupChecklist } from '../Welcome.setup'
import { resumeStep } from './setup.open'
import { SETUP_TEXT } from './setup.labels'
import { CommandsStep } from './setup.commands'
import type { StepNav } from './setup.ui'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const nav = (): StepNav => ({ index: 2, total: SETUP_STEPS.length, back: vi.fn(), skip: vi.fn(), next: vi.fn() })

describe('Commands step', () => {
  it('sits after Browser and before Central, with its own name and description', () => {
    expect(SETUP_STEPS.indexOf('commands')).toBe(SETUP_STEPS.indexOf('browser') + 1)
    expect(SETUP_STEPS.indexOf('commands')).toBeLessThan(SETUP_STEPS.indexOf('central'))
    expect(SETUP_TEXT.steps.commands).toBe('Commands')
  })

  it('shows the panel and the "change later" line; Skip leaves it unanswered on the server', async () => {
    const s = fakeCommands()
    const n = nav()
    render(<CommandsStep nav={n} />)
    await screen.findByText(COMMANDS_TEXT.found.title)
    expect(screen.getByRole('heading', { name: SETUP_TEXT.steps.commands })).toBeTruthy()
    expect(screen.getByText(SETUP_TEXT.changeLater(SETUP_TEXT.commands.where))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXT.skip }))
    expect(n.skip).toHaveBeenCalledOnce()
    expect(s.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('Continue works even when the load failed (the step is optional)', async () => {
    fakeCommands({ loadFail: 1 })
    const n = nav()
    render(<CommandsStep nav={n} />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: SETUP_TEXT.next }))
    await waitFor(() => expect(n.next).toHaveBeenCalledOnce())
  })
})

describe('installs that finished setup before this step existed', () => {
  // An old document: every then-existing step answered, completedAt set, no `commands` key.
  const old: SetupState = { completedAt: 1700000000000, steps: { claude: 'done', browser: 'skipped', central: 'done', basics: 'done' } }

  it('stay completed after load and merge: the new step is simply unanswered', () => {
    expect(normalizeSetup(old)).toEqual(old)
    const merged = mergeSettings({ setup: old }).setup
    expect(merged.completedAt).toBe(1700000000000)
    expect(merged.steps.commands).toBeUndefined()
    expect(applySettingsPatch({ ...DEFAULT_SETTINGS, setup: old }, { setup: { steps: { commands: 'skipped' } } }).setup.completedAt).toBe(1700000000000)
  })

  it('do not see the Welcome checklist again', () => {
    const { container } = render(<SetupChecklist setup={old} onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('the boot backfill leaves a stored setup alone', () => {
    const save = vi.fn()
    const r = backfillSetup({ storedJson: () => JSON.stringify({ setup: old }), save, existingInstall: () => true })
    expect(r).toBe('skipped')
    expect(save).not.toHaveBeenCalled()
  })

  it('a wizard that is still unfinished resumes at the new step, not at the start', () => {
    expect(resumeStep({ completedAt: null, steps: { claude: 'done', browser: 'done' } })).toBe('commands')
  })
})
