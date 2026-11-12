// The long-lived Central runtime holds one preflight handle: a fresh check (Settings test, profile edit)
// must reach it, so the handle stays the same while the probe behind it is replaced.
import { describe, expect, it } from 'vitest'
import { claudePreflightOf, freshClaudePreflight } from './centralChatHealth'

describe('freshClaudePreflight', () => {
  it('keeps the handle the runtime holds stable across a fresh check; an injected preflight wins', () => {
    const held = claudePreflightOf()
    expect(claudePreflightOf()).toBe(held)
    expect(freshClaudePreflight()).toBe(held)
    const own = async () => ({ ok: true as const })
    expect(claudePreflightOf({ preflight: own })).toBe(own)
  })
})
