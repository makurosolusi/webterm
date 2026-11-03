import { expect, it } from 'vitest'
import { FILES_SLOTS } from './filesSlots'

const slot = (id: string) => FILES_SLOTS.find((s) => s.id === id)

it('urutan slot tetap (kontrak §5.4) dan id unik', () => {
  expect(FILES_SLOTS.map((s) => s.id)).toEqual(['mutate', 'git', 'watch', 'search', 'dnd', 'upload'])
})

it('mutate: menu + onKey + overlay + useSlot, tanpa decorate/toolbar', () => {
  const s = slot('mutate')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.onKey).toBeTypeOf('function')
  expect(s?.overlay).toBeTypeOf('function')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.decorate).toBeUndefined()
  expect(s?.toolbar).toBeUndefined()
})

it('git hanya boleh decorate; watch (stub) tidak menambah menu/dekorasi/toolbar/tombol', () => {
  for (const id of ['git', 'watch']) {
    const s = slot(id)
    expect(s?.menu, id).toBeUndefined()
    expect(s?.toolbar, id).toBeUndefined()
    expect(s?.onKey, id).toBeUndefined()
    if (id !== 'git') expect(s?.decorate, id).toBeUndefined()
  }
})

it('search (nyata, WS-FM-09): useSlot + overlay, tanpa menu/toolbar/onKey/decorate', () => {
  const s = slot('search')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.overlay).toBeTypeOf('function')
  expect(s?.menu).toBeUndefined()
  expect(s?.toolbar).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
  expect(s?.decorate).toBeUndefined()
})

it('dnd (nyata, WS-FM-09): useSlot + menu, tanpa toolbar/onKey/decorate/overlay', () => {
  const s = slot('dnd')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.toolbar).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
  expect(s?.decorate).toBeUndefined()
  expect(s?.overlay).toBeUndefined()
})

it('upload (nyata, WS-FM-10): punya menu + toolbar, tanpa decorate/onKey', () => {
  const s = slot('upload')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.toolbar).toBeTypeOf('function')
  expect(s?.decorate).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
})
