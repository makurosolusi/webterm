import { expect, test } from 'bun:test'
import { classifyClaudeFailure } from '../runtime/claudeFailure'
import { failureKindOfStop, failureKindOfText, isTransientKind, type FailureKind } from './workFailureKind'

const facts = (resultText: string) => ({ exitCode: 1, signal: null, stderr: '', sawInit: true, resultText, secrets: [] })

const MESSAGES: ReadonlyArray<[string, FailureKind]> = [
  ['Unable to connect to API', 'network'],
  ["Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'network'],
  ['No internet route (EHOSTUNREACH)', 'network'],
  ['Connection dropped (ECONNRESET)', 'network'],
  ['Request timed out', 'network'],
  ['Request rejected (429)', 'rate_limited'],
  ["You've hit your session limit · resets 3:45pm", 'rate_limited'],
  ['API Error: 529 overloaded_error', 'overloaded'],
  ['API Error: 500 internal server error', 'server'],
  ['API Error: 503 Service Unavailable', 'server'],
  ['Your credit balance is too low to access the Anthropic API', 'permanent'],
  ['Request rejected (429): monthly spend limit reached', 'permanent'],
  ['Billing error: payment required', 'permanent'],
  ['Invalid API key · Please run /login', 'auth'],
  ['401 authentication_error', 'auth'],
  ['something odd happened', 'unknown'],
]

test('every documented message maps to its class; money and credentials are never retryable', () => {
  for (const [text, kind] of MESSAGES) {
    expect([text, failureKindOfText(text)]).toEqual([text, kind])
    const got = classifyClaudeFailure(facts(text))
    expect([text, got.kind, got.retryable === true]).toEqual([text, kind, isTransientKind(kind)])
  }
  for (const text of ['Your credit balance is too low', 'Request rejected (429): spend cap', 'Invalid API key']) {
    expect(classifyClaudeFailure(facts(text))).not.toMatchObject({ retryable: true })
  }
})

test('StopFailure.error: every documented value is mapped', () => {
  const table: Record<string, FailureKind> = {
    rate_limit: 'rate_limited', overloaded: 'overloaded', server_error: 'server', authentication_failed: 'auth', oauth_org_not_allowed: 'auth',
    account_on_hold: 'auth', cloud_credential_error: 'auth', billing_error: 'permanent', invalid_request: 'permanent', model_not_found: 'permanent',
    max_output_tokens: 'permanent', unknown: 'unknown',
  }
  for (const [error, kind] of Object.entries(table)) expect([error, failureKindOfStop(error)]).toEqual([error, kind])
  expect(failureKindOfStop('some_future_value')).toBe('unknown')
  expect(failureKindOfStop('unknown', 'Connection dropped (ECONNRESET)')).toBe('network')
  expect(failureKindOfStop('billing_error', 'ECONNRESET')).toBe('permanent')
})
