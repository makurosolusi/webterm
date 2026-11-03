import { expect, it } from 'vitest'
import { FILES_SLOTS } from './filesSlots'

it('urutan slot tetap (kontrak §5.4) dan id unik', () => {
  expect(FILES_SLOTS.map((s) => s.id)).toEqual(['mutate', 'git', 'watch', 'search', 'dnd', 'upload'])
})

it('stub W0a tidak menambah menu/dekorasi/toolbar apa pun', () => {
  for (const s of FILES_SLOTS) {
    expect(s.menu, s.id).toBeUndefined()
    expect(s.decorate, s.id).toBeUndefined()
    expect(s.toolbar, s.id).toBeUndefined()
    expect(s.onKey, s.id).toBeUndefined()
  }
})
