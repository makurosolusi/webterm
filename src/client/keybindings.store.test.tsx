/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYBINDINGS_STORAGE_KEY, connectKeybindings, keybindingOverrides, migrateCommandIds, resetKeybinding, setKeybinding, useKeybindingsSync } from './keybindings.store'
import { nextSettings } from '../server/settingsStore'
import type { Settings } from '../shared/settings'

function Sync({ value, hydrated, update }: { value: Settings['keybindings']; hydrated: boolean; update: (p: Partial<Settings>) => void }) {
  useKeybindingsSync(value, hydrated, update)
  return null
}

beforeEach(() => { localStorage.clear(); connectKeybindings({}, null) })
afterEach(cleanup)

describe('keybindings in server settings', () => {
  it('waits for the settings load, then mirrors settings and writes changes back as a settings patch', () => {
    const update = vi.fn()
    const { rerender } = render(<Sync value={{ 'view.fit': 'Mod+L' }} hydrated={false} update={update} />)
    expect(keybindingOverrides()).toEqual({})
    rerender(<Sync value={{ 'view.fit': 'Mod+L' }} hydrated update={update} />)
    expect(keybindingOverrides()).toEqual({ 'view.fit': 'Mod+L' })
    setKeybinding('workbench.quickOpen', 'Mod+O')
    expect(update).toHaveBeenLastCalledWith({ keybindings: { 'view.fit': 'Mod+L', 'workbench.quickOpen': 'Mod+O' } })
    resetKeybinding('view.fit')
    expect(update).toHaveBeenLastCalledWith({ keybindings: { 'workbench.quickOpen': 'Mod+O' } })
  })

  it('migrates legacy localStorage overrides once (server wins a clash) and removes the old key', () => {
    localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ 'view.fit': 'Mod+1', 'view.chat': null, junk: 5 }))
    const update = vi.fn()
    const { rerender } = render(<Sync value={{ 'view.fit': 'Mod+L' }} hydrated update={update} />)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ keybindings: { 'view.fit': 'Mod+L', 'view.chat': null } })
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull()
    rerender(<Sync value={{ 'view.fit': 'Mod+L', 'view.chat': null }} hydrated update={update} />)
    expect(update).toHaveBeenCalledTimes(1) // no second migration
  })

  it('renames old command ids once (an override already under the new id wins)', () => {
    const update = vi.fn()
    const value = { 'output.toggle.key': 'Mod+Alt+O', 'view.cleanView.key': 'Mod+Alt+.', 'view.fit': 'Mod+L' }
    const { rerender } = render(<Sync value={value} hydrated update={update} />)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ keybindings: { 'output.toggle': 'Mod+Alt+O', 'view.cleanView': 'Mod+Alt+.', 'view.fit': 'Mod+L' } })
    rerender(<Sync value={keybindingOverrides()} hydrated update={update} />)
    expect(update).toHaveBeenCalledTimes(1)
    expect(migrateCommandIds({ 'output.toggle.key': 'Mod+1', 'output.toggle': 'Mod+2' })).toEqual({ 'output.toggle': 'Mod+2' })
    expect(migrateCommandIds({ 'view.fit': 'Mod+L' })).toBeNull()
  })

  it('keeps overrides in write order, so a re-bound command becomes the most recent', () => {
    connectKeybindings({ a: 'Mod+1', b: 'Mod+2' }, null)
    setKeybinding('a', 'Mod+3')
    expect(Object.keys(keybindingOverrides())).toEqual(['b', 'a'])
  })

  it('no legacy overrides: nothing is written on load', () => {
    const update = vi.fn()
    render(<Sync value={{}} hydrated update={update} />)
    expect(update).not.toHaveBeenCalled()
  })

  it('the server store keeps the patch and validates it', () => {
    const saved = nextSettings(JSON.stringify({ keybindings: { a: 'Mod+A' } }), { keybindings: { b: 'Mod+B', c: 3 } })
    expect(saved.keybindings).toEqual({ b: 'Mod+B' })
    expect(nextSettings(JSON.stringify({ keybindings: { a: 'Mod+A' } }), { fontSize: 14 }).keybindings).toEqual({ a: 'Mod+A' })
  })
})
