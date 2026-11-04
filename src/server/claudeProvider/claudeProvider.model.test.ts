import { describe, expect, it } from 'vitest'
import { applyProviderEnv, CLOUD_FLAGS, normalizeBaseUrl, parseUpdate, providerEnv, SCRUB_VAR } from './claudeProvider.model'

const KEY = 'sk-test-only-0123456789' // test-only

describe('providerEnv (resolver)', () => {
  it('login mode injects and clears nothing', () => {
    expect(providerEnv({ mode: 'login' }, KEY)).toEqual({ set: {}, unset: [] })
  })

  it('a key mode without a secret is a no-op (never an empty credential)', () => {
    expect(providerEnv({ mode: 'apiKey' }, null)).toEqual({ set: {}, unset: [] })
    expect(providerEnv({ mode: 'custom', credential: 'authToken' }, KEY)).toEqual({ set: {}, unset: [] }) // no base URL
  })

  it('apiKey mode: ANTHROPIC_API_KEY only, clears the bearer token, base URL and cloud flags that would outrank it', () => {
    const pe = providerEnv({ mode: 'apiKey', model: 'claude-sonnet-4-6' }, KEY)
    expect(pe.set).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-sonnet-4-6', [SCRUB_VAR]: '1' })
    expect(pe.unset).toEqual(expect.arrayContaining(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...CLOUD_FLAGS]))
    expect(pe.unset).not.toContain('ANTHROPIC_API_KEY')
  })

  it('custom + authToken: Bearer variable + base URL, clears ANTHROPIC_API_KEY', () => {
    const pe = providerEnv({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' }, KEY)
    expect(pe.set).toEqual({ ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: 'https://gw.example.test', [SCRUB_VAR]: '1' })
    expect(pe.unset).toContain('ANTHROPIC_API_KEY')
  })

  it('custom + apiKey: x-api-key variable + base URL, clears ANTHROPIC_AUTH_TOKEN (it would win by precedence)', () => {
    const pe = providerEnv({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'apiKey' }, KEY)
    expect(pe.set.ANTHROPIC_API_KEY).toBe(KEY)
    expect(pe.unset).toContain('ANTHROPIC_AUTH_TOKEN')
  })

  it('applyProviderEnv removes inherited outranking vars and sets the chosen ones', () => {
    const base = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'inherited', CLAUDE_CODE_USE_BEDROCK: '1', X: undefined }
    const out = applyProviderEnv(base, providerEnv({ mode: 'apiKey' }, KEY))
    expect(out).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: KEY, [SCRUB_VAR]: '1' })
    expect(applyProviderEnv(base, providerEnv({ mode: 'login' }, KEY))).toEqual({ PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'inherited', CLAUDE_CODE_USE_BEDROCK: '1' })
  })
})

describe('normalizeBaseUrl', () => {
  it('keeps origin + path, drops trailing slash and /v1', () => {
    expect(normalizeBaseUrl('https://gw.example.test/anthropic/v1/')).toBe('https://gw.example.test/anthropic')
    expect(normalizeBaseUrl(' http://127.0.0.1:4000 ')).toBe('http://127.0.0.1:4000')
  })
  it('rejects non-http, embedded credentials, query and garbage', () => {
    for (const bad of ['ftp://x.test', 'https://u:p@x.test', 'https://x.test/?k=1', 'https://x.test/#f', 'not a url']) expect(normalizeBaseUrl(bad)).toBeNull()
  })
})

describe('parseUpdate', () => {
  it('validates mode, base URL, model and secret with static error codes', () => {
    expect(parseUpdate({ mode: 'nope' })).toEqual({ ok: false, error: 'invalid_mode' })
    expect(parseUpdate({ mode: 'custom', baseUrl: 'x' })).toEqual({ ok: false, error: 'invalid_base_url' })
    expect(parseUpdate({ mode: 'apiKey', model: 'bad model;' })).toEqual({ ok: false, error: 'invalid_model' })
    const bad = parseUpdate({ mode: 'apiKey', secret: 'short' })
    expect(bad).toEqual({ ok: false, error: 'invalid_secret' })
    expect(JSON.stringify(parseUpdate({ mode: 'apiKey', secret: `${KEY} with space` }))).not.toContain(KEY)
  })
  it('secret absent = keep, empty = remove, string = replace; custom defaults to Bearer', () => {
    expect(parseUpdate({ mode: 'apiKey' })).toEqual({ ok: true, config: { mode: 'apiKey' } })
    expect(parseUpdate({ mode: 'apiKey', secret: '' })).toEqual({ ok: true, config: { mode: 'apiKey' }, secret: null })
    expect(parseUpdate({ mode: 'custom', baseUrl: 'https://gw.example.test', secret: KEY })).toEqual({
      ok: true, config: { mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' }, secret: KEY,
    })
    expect(parseUpdate({ mode: 'login', model: 'x', baseUrl: 'https://gw.example.test' })).toEqual({ ok: true, config: { mode: 'login' } })
  })
})
