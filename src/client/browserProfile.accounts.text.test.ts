import { describe, expect, it } from 'vitest'
import type { ProfileAccount } from '../shared/browser.accounts'
import { ACCOUNT_CHECK_TTL_MS } from '../shared/browser.accounts'
import { accountDetail, accountTitle, REASON_TEXT, accountsStale, accountsSummary, agoText, hasSignedIn, visibleAccounts } from './browserProfile.accounts.text'

// test-only accounts
const g = (over: Partial<ProfileAccount> = {}): ProfileAccount => ({ provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', checkedAt: 1000, ...over })
const h = (over: Partial<ProfileAccount> = {}): ProfileAccount => ({ provider: 'github', state: 'signed_out', checkedAt: 1000, ...over })

describe('agoText', () => {
  it('rounds down to the largest unit and never goes negative', () => {
    expect(agoText(1000, 1000)).toBe('just now')
    expect(agoText(1000 + 59_000, 1000)).toBe('just now')
    expect(agoText(1000 + 5 * 60_000, 1000)).toBe('5 min ago')
    expect(agoText(1000 + 3 * 3_600_000, 1000)).toBe('3 h ago')
    expect(agoText(1000 + 2 * 86_400_000, 1000)).toBe('2 d ago')
    expect(agoText(0, 5000)).toBe('just now')
  })
})

describe('accountsSummary', () => {
  it('names the three situations and never a full address', () => {
    expect(accountsSummary([])).toBe('No accounts detected')
    expect(accountsSummary([g({ state: 'signed_out' }), h()])).toBe('Not signed in')
    expect(accountsSummary([g(), h()])).toBe('Google: Test Person (t***@gmail.com)')
    expect(accountsSummary([g({ state: 'expired' }), h({ state: 'unknown' })])).toBe('Google: Session expired, GitHub: Unknown')
  })
})

describe('helpers', () => {
  it('visibleAccounts hides signed-out providers; hasSignedIn counts only signed_in', () => {
    expect(visibleAccounts([g(), h()]).map((a) => a.provider)).toEqual(['google'])
    expect(hasSignedIn([g({ state: 'expired' })])).toBe(false)
    expect(hasSignedIn([g()])).toBe(true)
    expect(hasSignedIn(undefined)).toBe(false)
  })
  it('accountsStale: nothing known, or an answer older than the TTL', () => {
    expect(accountsStale([], 5)).toBe(true)
    expect(accountsStale([g()], 1000 + ACCOUNT_CHECK_TTL_MS)).toBe(false)
    expect(accountsStale([g()], 1000 + ACCOUNT_CHECK_TTL_MS + 1)).toBe(true)
  })
  it('accountDetail carries provider, name, masked email, state and age', () => {
    expect(accountDetail(g(), 1000 + 120_000)).toBe('Google · Test Person · t***@gmail.com · Signed in · checked 2 min ago')
  })
})

describe('reason', () => {
  it('an unknown row says why, in the title and the hover; a nameless signed-in row stays "Signed in"', () => {
    const u = g({ state: 'unknown', reason: 'parse_failed', displayName: undefined })
    expect(accountTitle(u)).toBe("Google · Unknown — couldn't parse the response")
    expect(accountDetail(u, 1000)).toContain(REASON_TEXT.parse_failed)
    expect(accountTitle(g({ displayName: undefined, reason: 'identity_unavailable' }))).toBe('Google · Signed in')
  })
})
