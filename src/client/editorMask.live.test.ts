import { afterEach, describe, expect, it } from 'vitest'
import { maskDiskText, publishMaskSetting } from './editorMask.live'

afterEach(() => publishMaskSetting(true))

describe('maskDiskText (peek / rename preview text)', () => {
  const text = 'API_KEY=abcdef1234567890zzzz\n'
  it('hides secrets with same-length bullets while masking is on', () => {
    const out = maskDiskText('/x/.env', text)
    expect(out).toBe(`API_KEY=${'•'.repeat(20)}\n`)
    expect(out.length).toBe(text.length)
  })
  it('returns the text untouched when the setting is off', () => {
    publishMaskSetting(false)
    expect(maskDiskText('/x/.env', text)).toBe(text)
  })
})
