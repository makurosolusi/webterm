/** @vitest-environment jsdom */
// The agent header has ONE labelled status chip, always present, from the shared status model.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionStatusView } from './sessionStatus.model'
import { agentStatusInput, NodeStatusChip } from './NodeStatusChip'

afterEach(cleanup)

const T0 = 1_000_000 // test-only clock
const chipOf = (o: Parameters<typeof agentStatusInput>[0]) => sessionStatusView(agentStatusInput(o)).chip
const tipOf = (el: Element) => {
  fireEvent.keyDown(document, { key: 'Tab' })
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}

describe('agentStatusInput', () => {
  it('Starting… until this launch prints something, then Ready', () => {
    expect(chipOf({ openedAt: T0 })).toBe('Starting…')
    // Output of the previous process (before this launch) does not count.
    expect(chipOf({ openedAt: T0, lastOutputAt: T0 - 1 })).toBe('Starting…')
    expect(chipOf({ openedAt: T0, lastOutputAt: T0 + 5 })).toBe('Ready')
  })

  it('a hook status or an exit wins over Starting…', () => {
    expect(chipOf({ openedAt: T0, status: 'working' })).toBe('Working')
    expect(chipOf({ openedAt: T0, status: 'waiting', lastOutputAt: T0 + 1 })).toBe('Turn ended')
    expect(chipOf({ openedAt: T0, status: 'failed' })).toBe('Failed')
    expect(chipOf({ openedAt: T0, status: 'stopped' })).toBe('Stopped')
    expect(chipOf({ openedAt: T0, exit: { code: 0 } })).toBe('Exited')
  })

  it('carries the reason, so Needs you says what it waits for', () => {
    const v = sessionStatusView(agentStatusInput({ openedAt: T0, status: 'blocked', reason: { reason: 'permission', detail: 'Bash' } }))
    expect(v.chip).toBe('Needs you')
    expect(v.label).toBe('Waiting for approval: Bash')
  })
})

describe('NodeStatusChip', () => {
  it('shows the short word, its tone, and the reason sentence as a real tooltip (no native title)', () => {
    const view = sessionStatusView({ status: 'blocked', reason: 'permission', detail: 'Bash' })
    const { container } = render(<NodeStatusChip view={view} />)
    const chip = container.querySelector('.node-status') as HTMLElement
    expect(chip.textContent).toBe('Needs you')
    expect(chip.classList.contains('node-status--attention')).toBe(true)
    expect(chip.getAttribute('aria-label')).toBe('Status: Waiting for approval: Bash')
    expect(chip.querySelector('.codicon-bell')).not.toBeNull()
    expect(chip.hasAttribute('title')).toBe(false)
    expect(tipOf(chip)).toBe('Waiting for approval: Bash')
  })

  it('calm states have words but no icon; working spins', () => {
    const ready = render(<NodeStatusChip view={sessionStatusView({})} />).container.querySelector('.node-status')!
    expect(ready.textContent).toBe('Ready')
    expect(ready.querySelector('.codicon')).toBeNull()
    cleanup()
    const working = render(<NodeStatusChip view={sessionStatusView({ status: 'working' })} />).container.querySelector('.node-status')!
    expect(working.querySelector('.codicon-loading.codicon-modifier-spin')).not.toBeNull()
  })
})
