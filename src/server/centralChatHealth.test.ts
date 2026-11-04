// Periksa ulang eksplisit: probe claude bersama diganti baru (cache 30 s dilewati), polling biasa tetap berbagi.
import { describe, expect, it } from 'vitest'
import { claudePreflightOf, freshClaudePreflight } from './centralChatHealth'

describe('freshClaudePreflight', () => {
  it('polling biasa berbagi satu probe ber-cache; fresh membuat probe baru yang lalu dipakai bersama', () => {
    const cached = claudePreflightOf()
    expect(claudePreflightOf()).toBe(cached)
    const fresh = freshClaudePreflight()
    expect(fresh).not.toBe(cached)
    expect(claudePreflightOf()).toBe(fresh)
  })
})
