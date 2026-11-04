// `channel.bot.propose` (R3, RND/26 §3.2 / RND/30b WS-13): register a Telegram bot token for central.
// R3 means a human approval bound to this exact action plus a typed confirm phrase; the token goes only
// to the SecretStore and never into a result, audit key or error. Wiring into the registry is WS-19.
import { approvalDigest } from '../../../ledger/ledgerApproval'
import { BOT_ACCOUNT_RE } from '../../../channels/botManaged'
import { CENTRAL_BOTS_FLAG, type BotManager } from '../../../channels/botManager'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'

const ALLOWED_KEYS = ['accountId', 'botToken', 'purpose', 'confirm', 'approvalId'] as const
const PURPOSE_MAX = 200
const APPROVAL_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/
/** Approval `kind`/action name a human approves for this tool. */
export const BOT_APPROVAL_ACTION = 'channel.bot.propose'
/** Input fields that carry a raw secret on purpose (it goes to the SecretStore); MCP input redaction skips them. */
export const BOT_SECRET_INPUTS: readonly string[] = ['botToken']

/** The exact text a human types to confirm connecting `accountId`. */
export function botConfirmPhrase(accountId: string): string { return `connect bot ${accountId}` }

/** Action object a human approves; the digest is derived server-side and never contains the token. */
export function botApprovalAction(accountId: string, purpose: string): Record<string, string> {
  return { action: BOT_APPROVAL_ACTION, accountId, purpose }
}

export interface ChannelBotDefDeps {
  /** Resolves the manager at call time (it exists only when the bots flag is on). */
  manager(): BotManager | null
  /** Single-use ledger consume: true only for an approved, unexpired approval whose digest matches. */
  consumeApproval(approvalId: string, digest: string): boolean | Promise<boolean>
}

/** Builds the tool def. */
export function createChannelBotDef(deps: ChannelBotDefDeps): ToolDef {
  return {
    name: 'channel.bot.propose',
    summary: 'Register a Telegram bot token (verified with getMe, stored as a secret). Needs human approval and typed confirm.',
    tier: 'R3',
    flag: CENTRAL_BOTS_FLAG,
    projectScoped: false,
    usage: '{"accountId":"<a-z0-9_ slug>","botToken":"<BotFather token>","purpose":"<=200 chars","confirm":"connect bot <accountId>","approvalId":"<approved channel.bot.propose approval>"}. Returns only the bot username; the token is never shown again. Web approval only.',
    input: obj({ accountId: S.str(), botToken: S.str(), purpose: S.str(PURPOSE_MAX), confirm: S.str(), approvalId: S.str(200) }, [...ALLOWED_KEYS]),
    output: S.anyObj('Bot id and username; never the token.'),
    auditKeys: ['accountId', 'botId', 'username', 'tokenLength'],
    validate(input: ToolInput) {
      const { accountId, botToken, purpose, confirm, approvalId } = input
      const ok = Object.keys(input).every((k) => (ALLOWED_KEYS as readonly string[]).includes(k))
        && typeof accountId === 'string' && BOT_ACCOUNT_RE.test(accountId)
        && typeof botToken === 'string' && botToken.length > 0
        && typeof purpose === 'string' && purpose.trim().length > 0 && purpose.length <= PURPOSE_MAX
        && confirm === botConfirmPhrase(accountId)
        && typeof approvalId === 'string' && APPROVAL_ID_RE.test(approvalId)
      return ok ? null : 'invalid_shape'
    },
    async handler(_ctx, input): Promise<ToolResult> {
      const manager = deps.manager()
      if (!manager) return { ok: false, code: 'flag_off' }
      const accountId = input.accountId as string
      const purpose = input.purpose as string
      const approved = await deps.consumeApproval(input.approvalId as string, approvalDigest(botApprovalAction(accountId, purpose)))
      if (!approved) return { ok: false, code: 'approval_required' }
      const result = await manager.propose({ accountId, botToken: input.botToken as string, purpose })
      return result.ok ? { ok: true, data: { ...result.bot } } : { ok: false, code: result.code }
    },
  }
}
