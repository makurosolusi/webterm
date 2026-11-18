import { describe, expect, it } from 'vitest'
import { parseProbe } from './browser.accounts.parsers'
import type { ProbeRaw } from './browser.accounts.parsers'

// test-only fixtures: shapes of what the probe page showed, never real accounts.
const LIST_URL = 'https://accounts.google.com/ListAccounts?json=standard'
const acct = (over: Record<number, unknown> = {}): unknown[] => {
  const row: unknown[] = ['gaia.l.a', 1, 'Test Person', 'test.person@gmail.com', 'https://lh3.googleusercontent.com/a/x=s48', 1, 1, 0, 0, 1, '123456', 0, 0, 0, 0, 1]
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v
  return row
}
const google = (data: unknown, over: Partial<ProbeRaw> = {}): string =>
  JSON.stringify({ url: LIST_URL, title: '', text: typeof data === 'string' ? data : JSON.stringify(data), userLogin: null, avatar: null, ...over })
const github = (over: Partial<ProbeRaw>): string =>
  JSON.stringify({ url: 'https://github.com/', title: 'GitHub', text: 'Where the world builds software', userLogin: null, avatar: null, ...over })

describe('google ListAccounts parser', () => {
  it('signed in: name, masked email, provider avatar; the full address is never in the result', () => {
    const r = parseProbe('google', google(['gaia.l.a.r', [acct()]]))
    expect(r).toEqual({ challenge: false, state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', avatarUrl: 'https://lh3.googleusercontent.com/a/x=s48' })
    expect(JSON.stringify(r)).not.toContain('test.person')
  })
  it('accepts the anti-JSON-hijacking prefix', () => {
    expect(parseProbe('google', google(`)]}'\n${JSON.stringify(['gaia.l.a.r', [acct()]])}`))).toMatchObject({ state: 'signed_in' })
  })
  it('empty list = signed out; every account flagged signed out = signed out', () => {
    expect(parseProbe('google', google(['gaia.l.a.r', []]))).toEqual({ challenge: false, state: 'signed_out' })
    expect(parseProbe('google', google(['gaia.l.a.r', [acct({ 14: 1 })]]))).toEqual({ challenge: false, state: 'signed_out' })
  })
  it('all listed accounts invalid = expired; a valid one later in the list wins', () => {
    expect(parseProbe('google', google(['gaia.l.a.r', [acct({ 9: 0 })]]))).toMatchObject({ state: 'expired', emailMasked: 't***@gmail.com' })
    expect(parseProbe('google', google(['gaia.l.a.r', [acct({ 9: 0 }), acct({ 3: 'ok@x.com', 2: 'Ok' })]]))).toMatchObject({ state: 'signed_in', displayName: 'Ok' })
  })
  it('a foreign avatar host is dropped, the row still parses', () => {
    const r = parseProbe('google', google(['gaia.l.a.r', [acct({ 4: 'https://evil.example/p.png' })]]))
    expect(r).toMatchObject({ state: 'signed_in' })
    expect(r).not.toHaveProperty('avatarUrl')
  })
  it('anything unrecognised is unknown, never a guess or a throw', () => {
    for (const text of ['not json', '{"a":1}', '["only-one"]', '[1,"x"]']) expect(parseProbe('google', google(text))).toEqual({ challenge: false, state: 'unknown' })
    expect(parseProbe('google', google(['gaia.l.a.r', []], { url: 'https://accounts.google.com/v3/signin/identifier' }))).toEqual({ challenge: false, state: 'unknown' })
    expect(parseProbe('google', 'garbage')).toEqual({ challenge: false, state: 'unknown' })
    expect(parseProbe('google', undefined)).toEqual({ challenge: false, state: 'unknown' })
  })
  it('a human check page is a challenge', () => {
    expect(parseProbe('google', google('x', { url: 'https://www.google.com/sorry/index?continue=x' }))).toEqual({ challenge: true })
    expect(parseProbe('google', google('Our systems have detected unusual traffic from your computer network'))).toEqual({ challenge: true })
  })
})

describe('github page parser', () => {
  it('signed in from the user-login meta, avatar only from a GitHub host', () => {
    expect(parseProbe('github', github({ userLogin: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/1?s=64' })))
      .toEqual({ challenge: false, state: 'signed_in', displayName: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=64' })
    expect(parseProbe('github', github({ userLogin: 'octocat', avatar: 'https://evil.example/a.png' }))).not.toHaveProperty('avatarUrl')
  })
  it('empty meta = signed out; missing meta (markup changed) = unknown, not signed out', () => {
    expect(parseProbe('github', github({ userLogin: '' }))).toEqual({ challenge: false, state: 'signed_out' })
    expect(parseProbe('github', github({ userLogin: null }))).toEqual({ challenge: false, state: 'unknown' })
  })
  it('rejects a login that is not a GitHub login, and a redirect away from github.com', () => {
    expect(parseProbe('github', github({ userLogin: '<script>' }))).toEqual({ challenge: false, state: 'unknown' })
    expect(parseProbe('github', github({ userLogin: 'octocat', url: 'https://evil.example/' }))).toEqual({ challenge: false, state: 'unknown' })
  })
  it('a rate-limit page is a challenge', () => {
    expect(parseProbe('github', github({ title: 'Rate limit exceeded', userLogin: null }))).toEqual({ challenge: true })
    expect(parseProbe('github', github({ text: 'Too many requests', userLogin: '' }))).toEqual({ challenge: true })
  })
})
