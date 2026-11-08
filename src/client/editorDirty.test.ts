import { describe, expect, it, vi } from 'vitest'
import { isEditorDirty, saveEditor, setEditorDirty } from './editorDirty'

describe('editorDirty registry', () => {
  it('tracks dirty per node and clears on dirty=false', () => {
    setEditorDirty('e1', true, async () => true)
    expect(isEditorDirty('e1')).toBe(true)
    expect(isEditorDirty('e2')).toBe(false)
    setEditorDirty('e1', false)
    expect(isEditorDirty('e1')).toBe(false)
  })

  it('saveEditor runs the registered save and reports its result', async () => {
    const save = vi.fn(async () => true)
    setEditorDirty('e1', true, save)
    expect(await saveEditor('e1')).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    setEditorDirty('e1', true, async () => false)
    expect(await saveEditor('e1')).toBe(false)
    setEditorDirty('e1', false)
  })

  it('saveEditor is false with no save registered, or when the save throws', async () => {
    expect(await saveEditor('nobody')).toBe(false)
    setEditorDirty('e1', true)
    expect(await saveEditor('e1')).toBe(false)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setEditorDirty('e1', true, async () => { throw new Error('disk full') })
    expect(await saveEditor('e1')).toBe(false)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    setEditorDirty('e1', false)
  })
})
