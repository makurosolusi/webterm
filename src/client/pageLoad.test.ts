/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { afterPageLoad } from './pageLoad'

const setReadyState = (value: DocumentReadyState): void => {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value })
}

afterEach(() => {
  Reflect.deleteProperty(document, 'readyState') // back to jsdom's own getter
  vi.useRealTimers()
})

it('runs immediately once the page has loaded', () => {
  setReadyState('complete')
  const fn = vi.fn()
  afterPageLoad(fn)
  expect(fn).toHaveBeenCalledTimes(1)
})

it('waits for the load event, then the next macrotask', () => {
  vi.useFakeTimers()
  setReadyState('loading')
  const fn = vi.fn()
  afterPageLoad(fn)
  vi.runAllTimers()
  expect(fn).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('load'))
  expect(fn).not.toHaveBeenCalled()
  vi.runAllTimers()
  expect(fn).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('load'))
  vi.runAllTimers()
  expect(fn).toHaveBeenCalledTimes(1)
})

it('never runs when cancelled before load, or between load and its macrotask', () => {
  vi.useFakeTimers()
  setReadyState('interactive')
  const early = vi.fn()
  afterPageLoad(early)()
  const late = vi.fn()
  const cancelLate = afterPageLoad(late)
  window.dispatchEvent(new Event('load'))
  cancelLate()
  vi.runAllTimers()
  expect(early).not.toHaveBeenCalled()
  expect(late).not.toHaveBeenCalled()
})
