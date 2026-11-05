/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HelpOverlay, { HELP_TEXT } from './HelpOverlay'
import { registerCommands, type Command } from './commandRegistry'
import { FIXED_COMMANDS } from './commandRegistry.defaults'
import { connectKeybindings, keybindingOverrides } from './keybindings.store'

const open = vi.fn()
const find = vi.fn()
const REGISTRY: Command[] = [
  { id: 'workbench.quickOpen', label: 'Go to File…', defaultKey: 'Mod+P', run: open },
  { id: 'workbench.findInFiles', label: 'Search: Find in Files', defaultKey: 'Mod+Shift+F', run: find },
]
let off: () => void
const persisted = vi.fn()

beforeEach(() => {
  persisted.mockClear()
  connectKeybindings({}, persisted) // stands in for the settings writer App connects
  off = registerCommands(REGISTRY)
})
afterEach(() => { off(); cleanup() })

const row = (label: string) => screen.getAllByText(label)[0].closest('tr') as HTMLElement
const chips = (label: string) => Array.from(row(label).querySelectorAll('kbd')).map((k) => k.textContent)

describe('HelpOverlay', () => {
  it('is generated from the command registry: one row per registered command', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux x86_64" />)
    expect(screen.getByRole('dialog', { name: HELP_TEXT.title })).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Command', 'Keybinding'])
    // App commands registered here + the surface-owned shortcuts registered on import, + header row.
    expect(screen.getAllByRole('row')).toHaveLength(REGISTRY.length + FIXED_COMMANDS.length + 1)
    expect(chips('Search: Find in Files')).toEqual(['Ctrl', 'Shift', 'F'])
  })

  it('uses symbol chips without plus signs on macOS, gestures as plain text', () => {
    render(<HelpOverlay onClose={() => {}} platform="MacIntel" />)
    expect(chips('Terminal: Insert Newline Without Sending')).toEqual(['⇧', '↩'])
    expect(row('Terminal: Insert Newline Without Sending').textContent).not.toContain('+')
    expect(row('Canvas: Remove Context Link').querySelectorAll('kbd')).toHaveLength(0)
    expect(row('Canvas: Remove Context Link').textContent).toContain('Double-click edge')
  })

  it('rebinds a command by recording the next chord, and persists it', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux" />)
    fireEvent.click(screen.getByRole('button', { name: `${HELP_TEXT.change}: Go to File…` }))
    expect(screen.getByRole('status').textContent).toBe(HELP_TEXT.recording)
    act(() => { fireEvent.keyDown(window, { key: 'Control', code: 'ControlLeft', ctrlKey: true }) }) // bare modifier: still recording
    act(() => { fireEvent.keyDown(window, { key: 'o', code: 'KeyO', ctrlKey: true }) })
    expect(chips('Go to File…')).toEqual(['Ctrl', 'O'])
    expect(persisted).toHaveBeenLastCalledWith({ 'workbench.quickOpen': 'Mod+O' })
    fireEvent.click(screen.getByRole('button', { name: `${HELP_TEXT.reset}: Go to File…` }))
    expect(chips('Go to File…')).toEqual(['Ctrl', 'P'])
  })

  it('flags a conflicting chord in the same scope', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux" />)
    fireEvent.click(screen.getByRole('button', { name: `${HELP_TEXT.change}: Search: Find in Files` }))
    act(() => { fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true }) })
    expect(row('Search: Find in Files').querySelector('[data-slot="help-conflict"]')?.textContent).toBe(`${HELP_TEXT.conflict}Go to File…`)
    expect(row('Go to File…').querySelector('[data-slot="help-conflict"]')?.textContent).toBe(`${HELP_TEXT.conflict}Search: Find in Files`)
    // The Files-node ⌘P is another scope: no conflict note there.
    expect(row('Files: Go to File in This Folder (focused Files node)').querySelector('[data-slot="help-conflict"]')).toBeNull()
  })

  it('Escape while recording cancels the recording, not the overlay; fixed rows are not editable', () => {
    const onClose = vi.fn()
    render(<HelpOverlay onClose={onClose} platform="Linux" />)
    expect(row('File: Save (editor node)').querySelector('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${HELP_TEXT.change}: Go to File…` }))
    act(() => { fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' }) })
    expect(onClose).not.toHaveBeenCalled()
    expect(keybindingOverrides()).toEqual({})
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('removes a keybinding', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux" />)
    fireEvent.click(screen.getByRole('button', { name: `${HELP_TEXT.remove}: Go to File…` }))
    expect(chips('Go to File…')).toEqual([])
    expect(keybindingOverrides()).toEqual({ 'workbench.quickOpen': null })
  })

  it('row actions are icon buttons with a visible tooltip, not a native title', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux x86_64" />)
    const edit = screen.getByRole('button', { name: `${HELP_TEXT.change}: Go to File…` })
    expect(edit.hasAttribute('title')).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(edit)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(HELP_TEXT.change)
  })
})
