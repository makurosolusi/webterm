import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_PROVIDERS, cookieDomainMatches, describeAccount, maskEmail, safeAvatarUrl, signedInAccounts, validateAccount, validateAccounts,
} from './browser.accounts'

describe('maskEmail', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskEmail('bip@gmail.com')).toBe('b***@gmail.com')
    expect(maskEmail('  Alice.Smith@Example.ORG ')).toBe('A***@example.org')
  })
  it('refuses what is not an address', () => {
    for (const v of ['', 'nobody', 'a@b', '@x.com', 'a b@x.com', 42, null, undefined]) expect(maskEmail(v)).toBeUndefined()
  })
  it('never contains the rest of the local part', () => {
    expect(maskEmail('secretname@x.com')).not.toContain('ecret')
  })
})

describe('safeAvatarUrl', () => {
  const hosts = ['googleusercontent.com']
  it('accepts https on the provider host or a subdomain', () => {
    expect(safeAvatarUrl('https://lh3.googleusercontent.com/a/photo=s64', hosts)).toBe('https://lh3.googleusercontent.com/a/photo=s64')
  })
  it('rejects http, other hosts, credentials, look-alikes and junk', () => {
    for (const v of ['http://lh3.googleusercontent.com/x', 'https://evil.example/x', 'https://u:p@lh3.googleusercontent.com/x',
      'https://googleusercontent.com.evil.example/x', 'javascript:alert(1)', 'not a url', 7]) expect(safeAvatarUrl(v, hosts)).toBeUndefined()
  })
})

describe('cookieDomainMatches', () => {
  it('matches the domain and its subdomains, with or without the leading dot, not look-alikes', () => {
    expect(cookieDomainMatches('.google.com', 'google.com')).toBe(true)
    expect(cookieDomainMatches('accounts.google.com', 'google.com')).toBe(true)
    expect(cookieDomainMatches('notgoogle.com', 'google.com')).toBe(false)
    expect(cookieDomainMatches('google.com.evil.example', 'google.com')).toBe(false)
  })
})

describe('providers table', () => {
  it('has exactly Google and GitHub, each with a public https probe URL', () => {
    expect(ACCOUNT_PROVIDERS.map((p) => p.id)).toEqual(['google', 'github'])
    for (const p of ACCOUNT_PROVIDERS) expect(p.probeUrl.startsWith('https://')).toBe(true)
  })
})

describe('validateAccount', () => {
  const ok = { provider: 'github', state: 'signed_in', displayName: 'octo', checkedAt: 5 }
  it('rebuilds a valid account and drops unknown fields', () => {
    expect(validateAccount({ ...ok, cookie: 'secret' })).toEqual(ok)
  })
  it('drops bad provider, state or time', () => {
    expect(validateAccount({ ...ok, provider: 'twitter' })).toBeUndefined()
    expect(validateAccount({ ...ok, state: 'maybe' })).toBeUndefined()
    expect(validateAccount({ ...ok, checkedAt: 'now' })).toBeUndefined()
    expect(validateAccount(null)).toBeUndefined()
  })
  it('masks a full address that slipped in and drops a foreign avatar', () => {
    const a = validateAccount({ ...ok, emailMasked: 'bip@gmail.com', avatarUrl: 'https://evil.example/a.png' })
    expect(a?.emailMasked).toBe('b***@gmail.com')
    expect(a?.avatarUrl).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('bip@')
  })
  it('keeps an already masked address and strips control characters from the name', () => {
    const a = validateAccount({ ...ok, emailMasked: 'b***@gmail.com', displayName: 'Bi\u0000p' })
    expect(a).toMatchObject({ emailMasked: 'b***@gmail.com', displayName: 'Bi p' })
  })
  it('validateAccounts tolerates junk', () => {
    expect(validateAccounts('x')).toEqual([])
    expect(validateAccounts([ok, 1, { provider: 'x' }])).toEqual([ok])
  })
})

describe('summaries', () => {
  it('signedInAccounts and describeAccount', () => {
    const a = [
      { provider: 'google' as const, state: 'signed_in' as const, displayName: 'Bip', emailMasked: 'b***@gmail.com', checkedAt: 1 },
      { provider: 'github' as const, state: 'expired' as const, checkedAt: 1 },
    ]
    expect(signedInAccounts(a)).toHaveLength(1)
    expect(describeAccount(a[0])).toBe('Google: Bip (b***@gmail.com)')
    expect(describeAccount(a[1])).toBe('GitHub: expired')
    expect(signedInAccounts(undefined)).toEqual([])
  })
})
