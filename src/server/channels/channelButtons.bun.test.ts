import { describe, expect, test } from 'bun:test'
import { createLedger } from '../ledger/ledger'
import { openLedgerDb } from '../ledger/migration'
import { buildButtonDeps, createBackgroundTracker, ledgerChallengePort } from './channelButtons'
import { TELEGRAM_BOT_TOKEN_ENV_NAMES } from './telegramSend'

const TOKEN_ENV = TELEGRAM_BOT_TOKEN_ENV_NAMES[0]
const FAKE_TOKEN = 'test-only-token-123'

function fixture() {
  const db = openLedgerDb(':memory:')
  const ledger = createLedger(db, { now: () => 1_700_000_000_000 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  return { db, ledger }
}

describe('ledgerChallengePort', () => {
  test('returns the issued digest+nonce while pending, null after the decision or for unknown ids', () => {
    const { db, ledger } = fixture()
    const ch = ledger.approval.requestApproval({ id: 'ap1', projectId: 'p1', kind: 'agent.spawn', request: { a: 1 } })
    const port = ledgerChallengePort(db)
    expect(port.challengeFor('ap1')).toEqual({ digest: ch.digest, nonce: ch.nonce })
    expect(port.challengeFor('nope')).toBeNull()
    ledger.approval.decideApproval('ap1', { actor: 'human', approve: true, digest: ch.digest, nonce: ch.nonce })
    expect(port.challengeFor('ap1')).toBeNull()
  })
})

describe('buildButtonDeps', () => {
  test('on by default (zero-config); only an explicit off gives null so callbacks stay ignored', () => {
    const { db } = fixture()
    expect(buildButtonDeps(db, { env: {} })).not.toBeNull()
    expect(buildButtonDeps(db, { env: { WEBTERM_CHANNEL_APPROVAL_BUTTONS: 'typo' } })).not.toBeNull()
    expect(buildButtonDeps(db, { env: { WEBTERM_CHANNEL_APPROVAL_BUTTONS: 'off' } })).toBeNull()
  })

  test('answerCallback posts answerCallbackQuery with the id and clipped text', async () => {
    const { db } = fixture()
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const deps = buildButtonDeps(db, {
      env: { WEBTERM_CHANNEL_APPROVAL_BUTTONS: 'on', [TOKEN_ENV]: FAKE_TOKEN },
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) })
        return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }
      },
    })
    await deps?.answerCallback?.('cb1', 'x'.repeat(500))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.endsWith('/answerCallbackQuery')).toBe(true)
    expect(calls[0]?.body['callback_query_id']).toBe('cb1')
    expect(String(calls[0]?.body['text']).length).toBe(200)
  })

  test('no token means no request; a failing request is swallowed', async () => {
    const { db } = fixture()
    let hits = 0
    const fetch = async () => {
      hits++
      throw new Error('boom')
    }
    const noToken = buildButtonDeps(db, { env: { WEBTERM_CHANNEL_APPROVAL_BUTTONS: 'on' }, fetch })
    await noToken?.answerCallback?.('cb', 't')
    expect(hits).toBe(0)
    const withToken = buildButtonDeps(db, { env: { WEBTERM_CHANNEL_APPROVAL_BUTTONS: 'on', [TOKEN_ENV]: FAKE_TOKEN }, fetch })
    await withToken?.answerCallback?.('cb', 't')
    expect(hits).toBe(1)
  })
})

describe('createBackgroundTracker', () => {
  test('idle waits for tracked tasks and then resolves', async () => {
    const tracker = createBackgroundTracker()
    let done = false
    tracker.track(new Promise<void>((r) => setTimeout(() => { done = true; r() }, 20)))
    expect(done).toBe(false)
    await tracker.idle()
    expect(done).toBe(true)
  })
})
