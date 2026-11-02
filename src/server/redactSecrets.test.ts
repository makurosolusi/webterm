import { afterEach, describe, expect, it } from 'vitest'
import { PERSIST_LIMITS, REDACTED, SECRET_ENV_NAMES, redactSecrets, redactValue } from './redactSecrets'
import { failure } from './memoryFileHttpResponse'
import { renderMemoryFile } from './memory/memoryFileRender'
import { MemoryError } from './memory/memoryModel'
import { safeErrorText } from './channels/safeErrorText'
import { createTurnEmitter } from './central/runtime/runtimeEvents'

// test-only: shapes built from fake characters, never real credentials.
const FAKE = {
  ghp: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  gho: 'gho_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  pat: 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3',
  akia: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  asia: 'ASIA' + 'ABCDEFGHIJKLMNOP',
  sk: 'sk-' + 'abcdefghijklmnopqrstuvwx',
  slack: 'xoxb-' + '1234567890-abcdef',
  wcap: 'wcap_' + 'abcdefgh1234',
  bearer: 'abcdefgh12345678',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sigsigsig',
  bot: 'bot123456:ABCDEFGHIJKLMNOP',
}

describe('redactSecrets patterns', () => {
  it.each(Object.entries(FAKE).filter(([k]) => k !== 'bearer' && k !== 'bot'))('scrubs %s tokens', (_name, secret) => {
    const out = redactSecrets(`before ${secret} after`)
    expect(out).not.toContain(secret)
    expect(out).toBe(`before ${REDACTED} after`)
  })

  it('scrubs Bearer values and keeps the scheme', () => {
    expect(redactSecrets(`Authorization: Bearer ${FAKE.bearer}`)).not.toContain(FAKE.bearer)
    expect(redactSecrets(`bearer ${FAKE.bearer}`)).toBe(`bearer ${REDACTED}`)
  })

  it('scrubs Telegram bot tokens inside URLs', () => {
    const out = redactSecrets(`GET https://api.telegram.org/${FAKE.bot}/sendMessage failed`)
    expect(out).not.toContain('ABCDEFGHIJKLMNOP')
    expect(out).toContain('bot[redacted]')
  })

  it('scrubs private key blocks', () => {
    const text = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----\nafter'
    expect(redactSecrets(text)).toBe(`before\n${REDACTED}\nafter`)
  })

  it.each(['password=hunter2secret', 'GITHUB_TOKEN=plain-value-123', 'api_key: "plain-value-123"', 'token=supersecretvalue', 'DB_PASSWORD = plain-value-123', 'X_SECRET=plain-value-123'])(
    'scrubs credential-named pair %s',
    (pair) => {
      const out = redactSecrets(`cfg ${pair} end`)
      expect(out).not.toMatch(/hunter2secret|plain-value-123|supersecretvalue/)
      expect(out).toContain(REDACTED)
    }
  )

  it('leaves safe text alone', () => {
    for (const text of ['hello world', 'max_tokens=1000 and tokenizer ok', 'ask-me-anything sk-short', '']) {
      expect(redactSecrets(text)).toBe(text)
    }
  })

  it('is idempotent', () => {
    const text = Object.values(FAKE).join(' | ') + ' | password=hunter2secret | "api_key": "plain-value-123"'
    const once = redactSecrets(text)
    expect(redactSecrets(once)).toBe(once)
  })

  it('passes non-string input through without throwing', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(undefined as unknown as string)).toBeUndefined()
    expect(redactSecrets(42 as unknown as string)).toBe(42)
  })
})

describe('redactSecrets exact values', () => {
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    saved.clear()
  })

  it('scrubs explicit secrets', () => {
    const secret = 'hmac-secret-for-tests'
    expect(redactSecrets(`failed for ${secret}`, [secret, undefined, null])).toBe(`failed for ${REDACTED}`)
  })

  it('ignores secrets shorter than the minimum', () => {
    expect(redactSecrets('abc abc', ['abc'])).toBe('abc abc')
  })

  it('reads secret env values at call time', () => {
    const name = SECRET_ENV_NAMES[0]
    saved.set(name, process.env[name])
    process.env[name] = 'env-secret-value-123'
    expect(redactSecrets('seen env-secret-value-123')).not.toContain('env-secret-value-123')
    process.env[name] = 'rotated-secret-value-456'
    const out = redactSecrets('seen env-secret-value-123 rotated-secret-value-456')
    expect(out).not.toContain('rotated-secret-value-456')
  })
})

describe('redactValue', () => {
  it('masks secret-named keys and credential-shaped strings at any depth (persist limits)', () => {
    const redacted = redactValue({
      text: 'keep me',
      apiKey: 'sk-live-abcdefghijklmnop',
      nested: { authorization: 'Bearer abcdefghijkl', list: ['wcap_abcdefgh', 'plain'] },
      token_value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc',
    }, PERSIST_LIMITS) as Record<string, unknown>
    expect(redacted['text']).toBe('keep me')
    expect(redacted['apiKey']).toBe(REDACTED)
    expect(JSON.stringify(redacted)).not.toMatch(/sk-live|wcap_|eyJhbGci/)
    expect((redacted['nested'] as Record<string, unknown>)['list']).toEqual([REDACTED, 'plain'])
  })

  it('leaves ordinary payloads and primitives intact', () => {
    expect(redactValue({ taskId: 't1', ok: true, n: 2, nil: null })).toEqual({ taskId: 't1', ok: true, n: 2, nil: null })
    expect(redactValue('plain text')).toBe('plain text')
    expect(redactValue(42)).toBe(42)
  })

  it('deep-redacts by sensitive key without mutating the input', () => {
    const input = {
      apiKey: FAKE.sk,
      Authorization: 'Bearer abcdefghijklmnop',
      refresh_token: 'plain-token-value',
      nested: { token: 'plain-token-value', note: 'ok' },
      list: [FAKE.ghp, 3],
    }
    const out = redactValue(input) as Record<string, unknown>
    expect(out['apiKey']).toBe(REDACTED)
    expect(out['Authorization']).toBe(REDACTED)
    expect(out['refresh_token']).toBe(REDACTED)
    expect(out['nested']).toEqual({ token: REDACTED, note: 'ok' })
    expect(out['list']).toEqual([REDACTED, 3])
    expect(input.nested.token).toBe('plain-token-value')
  })

  it('caps depth and item count for streaming, but not for persisted payloads', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 10; i++) deep = { a: deep }
    expect(JSON.stringify(redactValue(deep))).toContain(REDACTED)
    expect(JSON.stringify(redactValue(deep, PERSIST_LIMITS))).toContain('leaf')
    const many = Array.from({ length: 80 }, (_, i) => i)
    expect(redactValue(many) as unknown[]).toHaveLength(50)
    expect(redactValue(many, PERSIST_LIMITS) as unknown[]).toHaveLength(80)
  })

  it('does not mask pattern-free long strings', () => {
    expect(redactValue({ note: 'x'.repeat(500) })).toEqual({ note: 'x'.repeat(500) })
  })
})

describe('single scrubber on every path (regression)', () => {
  // Shapes that only the conversation/runtime copies used to know now reach the channel/memory path.
  const only = [FAKE.ghp, FAKE.akia, FAKE.slack, FAKE.jwt, FAKE.sk]
  const text = `leak ${only.join(' ')}`

  it('memory file rendering scrubs the body and source fields', () => {
    const file = renderMemoryFile({
      id: 'm1', projectId: 'p1', scope: 'project', key: 'k', title: 't', body: text, status: 'fact',
      sourceKind: 'git', sourceRef: `ref ${FAKE.ghp}`, supersedes: null, supersededAt: null, createdAt: 1, updatedAt: 2,
    })
    for (const secret of only) expect(file).not.toContain(secret)
  })

  it('memory-file HTTP failures and channel error text scrub them', () => {
    const body = failure(new MemoryError(text)).body as { message: string }
    const channel = safeErrorText(text, 'fb', 500)
    for (const secret of only) {
      expect(body.message).not.toContain(secret)
      expect(channel).not.toContain(secret)
    }
  })

  it('conversation persistence payloads and runtime events scrub them', () => {
    const persisted = JSON.stringify(redactValue({ parts: [{ type: 'text', text }] }, PERSIST_LIMITS))
    const events: unknown[] = []
    const emitted = createTurnEmitter({ turnId: 't1', emit: (event) => events.push(event) })
    emitted.textDelta(text)
    const streamed = JSON.stringify(events)
    for (const secret of only) {
      expect(persisted).not.toContain(secret)
      expect(streamed).not.toContain(secret)
    }
  })
})
