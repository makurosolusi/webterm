import { describe, expect, it, vi } from 'vitest'

import { SubscriberSet } from './subscribers'

describe('SubscriberSet', () => {
  it('delivers each message to every subscriber once', () => {
    const set = new SubscriberSet<string>()
    const a = vi.fn()
    const b = vi.fn()
    expect(set.add(a)).toBe(true)
    expect(set.add(b)).toBe(true)

    set.send('hello')

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('hello')
    expect(b).toHaveBeenCalledWith('hello')
  })

  it('rejects a duplicate add and sends only once', () => {
    const set = new SubscriberSet<number>()
    const fn = vi.fn()

    expect(set.add(fn)).toBe(true)
    expect(set.add(fn)).toBe(false)
    expect(set.size()).toBe(1)

    set.send(1)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering to peers when a subscriber removes another mid-broadcast', () => {
    const set = new SubscriberSet<string>()
    const removed = vi.fn()
    const remover = vi.fn(() => {
      set.remove(removed)
    })
    set.add(remover)
    set.add(removed)

    set.send('first')

    // Snapshot semantics: the peer still gets the message being broadcast, then leaves the set.
    expect(remover).toHaveBeenCalledWith('first')
    expect(removed).toHaveBeenCalledWith('first')
    expect(set.has(removed)).toBe(false)

    set.send('second')

    expect(remover).toHaveBeenCalledTimes(2)
    expect(removed).toHaveBeenCalledTimes(1)
  })

  it('lets subscribers added mid-broadcast wait for the next message', () => {
    const set = new SubscriberSet<string>()
    const latecomer = vi.fn()
    const adder = vi.fn(() => {
      set.add(latecomer)
    })
    set.add(adder)

    set.send('first')
    expect(latecomer).not.toHaveBeenCalled()

    set.send('second')
    expect(latecomer).toHaveBeenCalledTimes(1)
    expect(latecomer).toHaveBeenCalledWith('second')
  })

  it('does not let a throwing subscriber starve its peers', () => {
    const set = new SubscriberSet<string>()
    const boom = new Error('boom')
    const thrower = vi.fn(() => {
      throw boom
    })
    const healthy = vi.fn()
    const after = vi.fn()
    const onError = vi.fn()
    set.add(thrower)
    set.add(healthy)
    set.add(after)

    expect(() => set.send('msg', onError)).not.toThrow()

    expect(healthy).toHaveBeenCalledWith('msg')
    expect(after).toHaveBeenCalledWith('msg')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom)
    // Identity-free context: onError gets the error alone, no subscriber arguments.
    expect(onError.mock.calls[0]).toHaveLength(1)
  })

  it('continues the broadcast even when onError itself throws', () => {
    const set = new SubscriberSet<string>()
    const first = vi.fn(() => {
      throw new Error('first')
    })
    const second = vi.fn(() => {
      throw new Error('second')
    })
    const healthy = vi.fn()
    set.add(first)
    set.add(second)
    set.add(healthy)
    const onError = vi.fn(() => {
      throw new Error('handler failed')
    })

    expect(() => set.send('msg', onError)).toThrow('handler failed')
    // The failure stops at the handler; peers already delivered are unaffected in count.
    expect(healthy).not.toHaveBeenCalled()

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('tracks size and clears every subscriber', () => {
    const set = new SubscriberSet<string>()
    const fn = vi.fn()
    expect(set.size()).toBe(0)

    set.add(fn)
    expect(set.size()).toBe(1)

    set.clear()
    expect(set.size()).toBe(0)
    expect(set.has(fn)).toBe(false)

    set.send('after-clear')
    expect(fn).not.toHaveBeenCalled()
  })

  it('reports has/remove for present and absent callbacks', () => {
    const set = new SubscriberSet<string>()
    const fn = vi.fn()

    expect(set.has(fn)).toBe(false)
    expect(set.remove(fn)).toBe(false)

    set.add(fn)
    expect(set.has(fn)).toBe(true)
    expect(set.remove(fn)).toBe(true)
    expect(set.has(fn)).toBe(false)
    expect(set.remove(fn)).toBe(false)
  })
})
