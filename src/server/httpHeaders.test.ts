import { describe, expect, it } from 'vitest'
import { firstHeader, headerValue } from './httpHeaders'

describe('headerValue', () => {
  it('finds a header case-insensitively', () => {
    expect(headerValue({ 'X-Token': 'abc' }, 'x-token')).toBe('abc')
  })
  it('treats a repeated (array) header as absent', () => {
    expect(headerValue({ 'x-token': ['a', 'b'] }, 'x-token')).toBeUndefined()
  })
  it('returns undefined for a missing header or missing bag', () => {
    expect(headerValue({}, 'x-token')).toBeUndefined()
    expect(headerValue(undefined, 'x-token')).toBeUndefined()
  })
})

describe('firstHeader', () => {
  it('returns a string as-is', () => expect(firstHeader('a')).toBe('a'))
  it('returns the first entry of an array', () => expect(firstHeader(['a', 'b'])).toBe('a'))
  it('returns undefined for undefined or an empty array', () => {
    expect(firstHeader(undefined)).toBeUndefined()
    expect(firstHeader([])).toBeUndefined()
  })
})
