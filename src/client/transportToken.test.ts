/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { isAbortError, peekToken, TOKEN_KEY, TOKEN_PARAM } from './transportToken'

afterEach(() => {
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})

describe('peekToken', () => {
  it('returns empty when neither URL nor storage has a token', () => {
    expect(peekToken()).toBe('')
  })

  it('falls back to sessionStorage', () => {
    sessionStorage.setItem(TOKEN_KEY, 'stored')
    expect(peekToken()).toBe('stored')
  })

  it('prefers the URL parameter and leaves URL and storage untouched', () => {
    sessionStorage.setItem(TOKEN_KEY, 'stored')
    history.replaceState(null, '', `/?${TOKEN_PARAM}=fromurl`)
    expect(peekToken()).toBe('fromurl')
    expect(location.search).toBe(`?${TOKEN_PARAM}=fromurl`)
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('stored')
  })
})

describe('isAbortError', () => {
  it('is true only for AbortError-named objects', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})
