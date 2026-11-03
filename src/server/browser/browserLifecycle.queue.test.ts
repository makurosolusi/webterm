import { describe, expect, it } from 'vitest'
import { LiveQueue } from './browserLifecycle.queue'

describe('LiveQueue', () => {
  it('keeps the original hiddenSince when hidden twice', () => {
    const q = new LiveQueue()
    q.add('a')
    q.setVisible('a', false, 100)
    q.setVisible('a', false, 500)
    expect(q.get('a')).toEqual({ visible: false, hiddenSince: 100 })
    q.setVisible('a', true, 600)
    expect(q.get('a')).toEqual({ visible: true, hiddenSince: null })
  })

  it('ignores unknown nodes', () => {
    expect(new LiveQueue().setVisible('x', false, 1)).toBeUndefined()
  })

  it('picks the oldest hidden evictable node, never a visible one', () => {
    const q = new LiveQueue()
    for (const id of ['a', 'b', 'c', 'd']) q.add(id)
    q.setVisible('b', false, 300)
    q.setVisible('c', false, 100)
    q.setVisible('d', false, 200)
    expect(q.oldestHidden(() => true)).toBe('c')
    expect(q.oldestHidden((id) => id !== 'c')).toBe('d')
    expect(q.oldestHidden(() => false)).toBeUndefined()
    q.remove('c')
    q.remove('d')
    q.remove('b')
    expect(q.oldestHidden(() => true)).toBeUndefined() // only visible 'a' left
    expect(q.size).toBe(1)
  })
})
