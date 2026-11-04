import { describe, expect, it } from 'vitest'
import { HYGIENE_FINDINGS_PATH, hygieneRoute, isSensitivePath, sensitivePattern } from './repoHygiene'

describe('isSensitivePath', () => {
  it.each([
    '.env', 'app/.env.local', '.env.production', 'id_rsa', 'keys/id_ed25519', 'server.pem', 'tls.key',
    'cert.p12', 'cert.pfx', 'release.keystore', 'credentials.json', 'service-account-prod.json',
    'cookies.txt', 'x.com_cookies.txt', '.aws/credentials', 'deep/.gcp/key.json',
  ])('flags %s', (p) => expect(isSensitivePath(p)).toBe(true))

  it.each(['.env.example', 'web/.env.sample', '.env.template', 'README.md', 'src/env.ts', 'monkey', 'keys.ts', 'aws/notes.md'])(
    'passes %s', (p) => expect(isSensitivePath(p)).toBe(false))

  it('names the matching pattern', () => {
    expect(sensitivePattern('a/b/.env.local')).toBe('.env.*')
    expect(sensitivePattern('C:\\u\\.aws\\config')).toBe('.aws/')
  })
})

describe('hygieneRoute', () => {
  it('answers GET findings only', () => {
    expect(hygieneRoute(HYGIENE_FINDINGS_PATH, 'GET')).toEqual({ status: 200, body: expect.any(Array) })
    expect(hygieneRoute(HYGIENE_FINDINGS_PATH, 'POST')).toBeNull()
    expect(hygieneRoute('/api/other', 'GET')).toBeNull()
  })
})
