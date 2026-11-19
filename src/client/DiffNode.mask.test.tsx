/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { DIFF_MASK_NOTICE, useDiffMask } from './DiffNode.mask'
import type { DiffSides } from './DiffNode.editor'
import { SettingsProvider } from './useSettings'

afterEach(() => { cleanup(); vi.useRealTimers() })

// test-only fixtures: fake values of the same length, so the masked sides look identical
const RAW: DiffSides = { path: '.env', original: 'API_KEY=aaaaaaaaaaaa\n', modified: 'API_KEY=bbbbbbbbbbbb\n' }
const BULLETS = '•'.repeat(12)

let seen: DiffSides | null = null
function Probe({ raw }: { raw: DiffSides | null }) {
  const m = useDiffMask(raw)
  seen = m.sides
  return <div>{m.bar}</div>
}
const mount = (s: Partial<Settings>, raw: DiffSides | null = RAW) =>
  render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, ...s }}><Probe raw={raw} /></SettingsProvider>)

describe('useDiffMask', () => {
  it('masks both sides and shows the control and the notice', () => {
    mount({ maskSecrets: true })
    expect(seen?.original).toBe(`API_KEY=${BULLETS}\n`)
    expect(seen?.modified).toBe(`API_KEY=${BULLETS}\n`)
    expect(screen.getByText('2 secrets masked · Reveal')).toBeTruthy()
    expect(screen.getByText(DIFF_MASK_NOTICE)).toBeTruthy()
  })

  it('Reveal shows the real values on both sides, Hide masks again', () => {
    mount({ maskSecrets: true })
    fireEvent.click(screen.getByText('2 secrets masked · Reveal'))
    expect(seen).toEqual(RAW)
    fireEvent.click(screen.getByText('Secrets revealed · Hide'))
    expect(seen?.original).toContain(BULLETS)
  })

  it('auto-hides after the configured seconds and hides on Escape', () => {
    vi.useFakeTimers()
    mount({ maskSecrets: true, maskAutoHideSec: 15 })
    fireEvent.click(screen.getByText('2 secrets masked · Reveal'))
    expect(seen).toEqual(RAW)
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(seen?.modified).toContain(BULLETS)
    fireEvent.click(screen.getByText('2 secrets masked · Reveal'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(seen?.modified).toContain(BULLETS)
  })

  it('does nothing when the setting is off', () => {
    mount({ maskSecrets: false })
    expect(seen).toBe(RAW)
    expect(screen.queryByTestId('diff-mask')).toBeNull()
  })

  it('shows no control for a file without secrets', () => {
    const plain = { path: 'a.ts', original: 'x\n', modified: 'y\n' }
    mount({ maskSecrets: true }, plain)
    expect(seen).toEqual(plain)
    expect(screen.queryByTestId('diff-mask')).toBeNull()
  })
})
