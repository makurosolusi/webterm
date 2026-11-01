import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_WEBHOOK_BODY_BYTES,
  MIN_TELEGRAM_SECRET_LENGTH,
  SECRET_ENV_NAMES,
  SIGNATURE_HEADER,
  TELEGRAM_SECRET_HEADER,
  TIMESTAMP_HEADER,
  AttemptThrottle,
  redactSecrets,
  signWebhook,
  telegramSecretProblem,
  verifyTelegramSecret,
  verifyWebhook,
  webhookResponse,
} from './webhook'

const SECRET = 'hmac-secret-for-tests'
const TG_SECRET = 'tg-secret-token-0123456789-abcdefghij'
const NOW = 1_700_000_000
const BODY = JSON.stringify({ hello: 'world' })

function signedHeaders(body = BODY, timestamp = NOW, secret = SECRET): Record<string, string> {
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signWebhook(secret, body, timestamp),
  }
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed, fresh body', () => {
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: BODY,
      headers: signedHeaders(),
      nowSeconds: NOW,
    })
    expect(result).toEqual({ ok: true, timestamp: NOW })
  })

  it('accepts a signature that is only valid for the exact raw body', () => {
    const headers = signedHeaders()
    const tampered = verifyWebhook({
      secret: SECRET,
      rawBody: `${BODY} `,
      headers,
      nowSeconds: NOW,
    })
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.status).toBe(401)
  })

  it('rejects a bad signature', () => {
    const headers = { ...signedHeaders(), [SIGNATURE_HEADER]: `sha256=${'0'.repeat(64)}` }
    const result = verifyWebhook({ secret: SECRET, rawBody: BODY, headers, nowSeconds: NOW })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_signature')
  })

  it('rejects a stale timestamp outside the replay window', () => {
    const stale = NOW - 301
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: BODY,
      headers: signedHeaders(BODY, stale),
      nowSeconds: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.reason).toBe('stale_timestamp')
    }
  })

  it('rejects a far-future timestamp too', () => {
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: BODY,
      headers: signedHeaders(BODY, NOW + 301),
      nowSeconds: NOW,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a missing timestamp, signature, or configured secret', () => {
    expect(verifyWebhook({ secret: SECRET, rawBody: BODY, headers: {}, nowSeconds: NOW }).ok).toBe(false)
    expect(
      verifyWebhook({ secret: '', rawBody: BODY, headers: signedHeaders(), nowSeconds: NOW })
    ).toEqual({ ok: false, status: 401, reason: 'secret_not_configured' })
    expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: BODY,
        headers: { [TIMESTAMP_HEADER]: String(NOW) },
        nowSeconds: NOW,
      })
    ).toEqual({ ok: false, status: 401, reason: 'missing_signature' })
  })

  it('rejects an oversized body with 413 before checking auth', () => {
    const body = 'a'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)
    const result = verifyWebhook({ secret: SECRET, rawBody: body, headers: {}, nowSeconds: NOW })
    expect(result).toEqual({ ok: false, status: 413, reason: 'body_too_large' })
    expect(webhookResponse(result).status).toBe(413)
  })

  it('maps verification outcomes onto HTTP responses', () => {
    expect(webhookResponse({ ok: true, timestamp: NOW }).status).toBe(200)
    expect(webhookResponse({ ok: true, timestamp: NOW }, 202).status).toBe(202)
    const rejected = webhookResponse({ ok: false, status: 401, reason: 'bad_signature' })
    expect(rejected.status).toBe(401)
    expect(rejected.body).toEqual({ ok: false, error: 'bad_signature' })
  })
})

describe('verifyTelegramSecret', () => {
  it('accepts the configured secret token', () => {
    const headers = { [TELEGRAM_SECRET_HEADER]: TG_SECRET }
    const result = verifyTelegramSecret(headers, TG_SECRET, { throttle: new AttemptThrottle() })
    expect(result.ok).toBe(true)
  })

  it('rejects a wrong or missing token and fails closed without configuration', () => {
    const throttle = new AttemptThrottle()
    const wrong = verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: `${TG_SECRET}x` }, TG_SECRET, {
      throttle,
    })
    expect(wrong).toMatchObject({ ok: false, status: 401, reason: 'bad_secret_token' })
    expect(verifyTelegramSecret({}, TG_SECRET, { throttle })).toMatchObject({
      ok: false,
      reason: 'missing_secret_token',
    })
    expect(verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: TG_SECRET }, undefined)).toEqual({
      ok: false,
      status: 401,
      reason: 'secret_not_configured',
    })
  })

  it('M3: refuses a configured secret shorter than the minimum, even when it matches', () => {
    const short = 'short-secret'
    expect(short.length).toBeLessThan(MIN_TELEGRAM_SECRET_LENGTH)
    expect(telegramSecretProblem(short)).toContain('at least')
    expect(verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: short }, short)).toMatchObject({
      ok: false,
      status: 401,
      reason: 'secret_too_weak',
    })
    expect(telegramSecretProblem('a'.repeat(33))).toBeNull()
    expect(telegramSecretProblem(`${'a'.repeat(32)}$`)).toContain('shape')
  })

  it('M3: throttles repeated failures per key and clears on success', () => {
    let now = 1_000
    const throttle = new AttemptThrottle({ limit: 3, windowMs: 1_000, now: () => now })
    const bad = { [TELEGRAM_SECRET_HEADER]: 'not-the-secret-at-all-000000000000' }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(verifyTelegramSecret(bad, TG_SECRET, { throttle, clientKey: 'peer-a' })).toMatchObject({
        ok: false,
        reason: 'bad_secret_token',
      })
    }
    // Budget exhausted: even the correct secret is refused for this key.
    expect(
      verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: TG_SECRET }, TG_SECRET, {
        throttle,
        clientKey: 'peer-a',
      })
    ).toMatchObject({ ok: false, reason: 'too_many_attempts' })
    // Another peer is unaffected (a guess flood cannot lock out the whole webhook).
    expect(
      verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: TG_SECRET }, TG_SECRET, {
        throttle,
        clientKey: 'peer-b',
      }).ok
    ).toBe(true)

    now += 1_001
    expect(
      verifyTelegramSecret({ [TELEGRAM_SECRET_HEADER]: TG_SECRET }, TG_SECRET, {
        throttle,
        clientKey: 'peer-a',
      }).ok
    ).toBe(true)
    // A success resets the budget immediately, so both peers hold no failure state.
    expect(throttle.allow('peer-a')).toBe(true)
    expect(throttle.size()).toBe(0)
  })
})

describe('redactSecrets', () => {
  const saved = new Map<string, string | undefined>()

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  it('scrubs explicit secrets and known token patterns', () => {
    const text = `send failed for ${SECRET} via bot123456:ABCDEFGHIJKLMNOP and Bearer abcdefgh12345678`
    const redacted = redactSecrets(text, [SECRET])
    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain('ABCDEFGHIJKLMNOP')
    expect(redacted).not.toContain('abcdefgh12345678')
  })

  it('reads secret env values at call time', () => {
    const name = SECRET_ENV_NAMES[0]
    saved.set(name, process.env[name])
    process.env[name] = 'env-secret-value-123'
    expect(redactSecrets('token=env-secret-value-123')).not.toContain('env-secret-value-123')
    process.env[name] = 'rotated-secret-value-456'
    expect(redactSecrets('token=env-secret-value-123 rotated-secret-value-456')).not.toContain(
      'rotated-secret-value-456'
    )
  })
})
