import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createManagedBotRegistry } from '../../../channels/botManaged'
import { CENTRAL_BOTS_FLAG, createBotManager } from '../../../channels/botManager'
import { CANARY_TOKEN, fakeTelegram } from '../../../channels/botManager.testutil'
import { createFileSecretStore } from '../../../envSecrets.store'
import { approvalDigest } from '../../../ledger/ledgerApproval'
import { configureLogging, setLogLevel } from '../../../logs'
import { logBus } from '../../../logs/logBus'
import { openFixture, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, Tier, ToolCtx } from '../toolTypes'
import { botApprovalAction, botConfirmPhrase, createChannelBotDef } from './channel.bot.def'

let f: Fixture
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webterm-botdef-'))
  configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
  setLogLevel('trace')
  logBus.clear()
})
afterEach(() => { f?.close(); rmSync(dir, { recursive: true, force: true }) })

const PURPOSE = 'ops alerts'
const GOOD_DIGEST = approvalDigest(botApprovalAction('ops', PURPOSE))

function setup(opts: { maxTier?: Tier; guard?: ControlGuard; env?: Record<string, string>; approve?: boolean } = {}) {
  f = openFixture()
  const tg = fakeTelegram({ getMe: { result: { id: 42, is_bot: true, username: 'central_bot' } } })
  const manager = createBotManager({ secrets: createFileSecretStore(join(dir, 'secrets')), registry: createManagedBotRegistry(join(dir, 'bots.json')), fetch: tg.fetch })
  const consumed: string[] = []
  const registry = createRegistry()
  registry.register(createChannelBotDef({
    manager: () => manager,
    consumeApproval: (id, digest) => { consumed.push(`${id}:${digest}`); return opts.approve !== false && digest === GOOD_DIGEST && id === 'ap1' },
  }))
  const ctx: ToolCtx = { db: f.db, registry, guard: opts.guard ?? ALLOW_ALL_GUARD, maxTier: opts.maxTier ?? 'R3', conversationId: 'central:global', now: () => 1_700_000_000_000, env: opts.env ?? { [CENTRAL_BOTS_FLAG]: 'on' } }
  return { ctx, tg, consumed, manager }
}
const args = (extra: Record<string, unknown> = {}) => ({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: PURPOSE, confirm: botConfirmPhrase('ops'), approvalId: 'ap1', ...extra })
const auditText = (): string => JSON.stringify(f.raw.prepare('SELECT payload_json FROM event').all())

describe('channel.bot.propose', () => {
  it('is off by default (flag)', async () => {
    const { ctx, tg } = setup({ env: {} })
    expect((await execTool(ctx, 'channel.bot.propose', args())).code).toBe('flag_off')
    expect(tg.calls).toHaveLength(0)
  })

  it('is R3: refused below R3 and when the guard demands approval; no network, no secret', async () => {
    const low = setup({ maxTier: 'R2' })
    expect((await execTool(low.ctx, 'channel.bot.propose', args())).code).toBe('tier_denied')
    expect(low.tg.calls).toHaveLength(0)
    f.close()
    const gated = setup({ guard: { check: () => ({ ok: false, code: 'needs_approval' }) } })
    expect((await execTool(gated.ctx, 'channel.bot.propose', args())).code).toBe('needs_approval')
    expect(existsSync(join(dir, 'secrets'))).toBe(false)
  })

  it('refuses without a valid approval or a wrong typed confirm, before touching Telegram', async () => {
    const s = setup({ approve: false })
    expect((await execTool(s.ctx, 'channel.bot.propose', args())).code).toBe('approval_required')
    expect((await execTool(s.ctx, 'channel.bot.propose', args({ approvalId: undefined }))).code).toBe('invalid_shape')
    expect((await execTool(s.ctx, 'channel.bot.propose', args({ confirm: 'yes' }))).code).toBe('invalid_shape')
    expect((await execTool(s.ctx, 'channel.bot.propose', args({ decision: 'approve' }))).code).toBe('forbidden_key')
    expect(s.tg.calls).toHaveLength(0)
    expect(existsSync(join(dir, 'secrets'))).toBe(false)
  })

  it('an approval for a different purpose does not match the digest', async () => {
    const s = setup()
    expect((await execTool(s.ctx, 'channel.bot.propose', args({ purpose: 'something else' }))).code).toBe('approval_required')
  })

  it('succeeds with approval: token only in the secret file, never in the result, audit or logs', async () => {
    const { ctx, consumed } = setup()
    const out = await execTool(ctx, 'channel.bot.propose', args())
    expect(out).toMatchObject({ ok: true, data: { accountId: 'ops', botId: 42, username: 'central_bot', tokenLength: CANARY_TOKEN.length } })
    expect(consumed).toEqual([`ap1:${GOOD_DIGEST}`])
    expect(JSON.stringify(out)).not.toContain(CANARY_TOKEN)
    expect(auditText()).toContain('central_bot')
    expect(auditText()).not.toContain(CANARY_TOKEN)
    expect(JSON.stringify(logBus.query())).not.toContain(CANARY_TOKEN)
    expect(readFileSync(join(dir, 'bots.json'), 'utf8')).not.toContain(CANARY_TOKEN)
    expect(readdirSync(join(dir, 'secrets'))).toEqual(['CHBOT_OPS_TOKEN'])
  })
})
