// Tipe + port ledger untuk runtime kanal Telegram; dipisah dari channelsRuntime.ts (batas Rule 8).
// channelsRuntime.ts me-re-export semuanya, jadi import lama tetap berlaku.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SecretStore } from '../envSecrets.store'
import type { ApprovalStatus } from '../ledger/ledgerApproval'
import type { Ledger } from '../ledger/ledger'
import type { ChannelStore } from './channelStore'
import type { ChannelApprovalPort, DispatchOutcome, TelegramCentralPort, TelegramDispatchDeps } from './channelDispatch'
import type { BotManager, BotManagerDeps } from './botManager'
import type { PendingChatStore } from './channelPending'
import type { SecretFileRead } from './channelSecret'
import type { SenderBootOptions } from './channelSenderBoot'
import type { FlushResult } from './telegramSender'
import type { TelegramMode } from './telegramMode'

/** Production approval port: the real ledger, unchanged, behind the dispatcher's narrow slice. */
export function ledgerApprovalPort(ledger: Ledger): ChannelApprovalPort {
  return {
    listApprovals: (opts) =>
      ledger.approval.listApprovals({
        projectId: opts?.projectId,
        status: opts?.status as ApprovalStatus | undefined,
        limit: opts?.limit,
      }),
    getApproval: (id) => ledger.approval.getApproval(id),
    decideApproval: (id, input) => ledger.approval.decideApproval(id, input),
    consumeApproval: (id, input) => ledger.approval.consumeApproval(id, input),
  }
}

export interface ChannelsRuntime {
  store: ChannelStore
  /** Ingress mode this runtime was booted in; poll mode installs no webhook route. */
  readonly mode: TelegramMode
  /** Same dedupe + dispatch + pending path as the webhook; the poller feeds updates through it. */
  ingest(update: unknown): Promise<DispatchOutcome>
  /** Resolves when no detached central turn is running (shutdown, tests). */
  idle(): Promise<void>
  /** True when the egress interval is running (a bot token was configured at boot). */
  readonly senderRunning: boolean
  /** Managed bots manager; null unless WEBTERM_CENTRAL_BOTS=on. */
  readonly bots: BotManager | null
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** Root-only binding CRUD. The caller MUST authorize first; false for any other path. */
  handleApi(req: IncomingMessage, res: ServerResponse): boolean
  /** Drain the reply outbox now; resolves to an idle result when egress is not configured. */
  flushNow(): Promise<FlushResult>
  /** Stop the egress interval. Safe to call more than once. */
  stop(): void
}

export interface ChannelsRuntimeOptions {
  env?: NodeJS.ProcessEnv
  storePath?: string
  now?: () => number
  /** Injection seam for tests; production reads the real filesystem. */
  readSecret?: (path: string) => SecretFileRead
  /** Egress pacing and transport seam; omitted in production (5s interval, global fetch). */
  sender?: SenderBootOptions
  centralChat?: TelegramCentralPort
  /** Approval-button deps (see `buildButtonDeps`); omitted = callbacks ignored. */
  buttons?: Pick<TelegramDispatchDeps, 'challenge' | 'answerCallback'> | null
  /** Test seam for the managed bots manager (secrets, registry, fetch). */
  bots?: Partial<BotManagerDeps>
  /** Secret store untuk secret webhook otomatis (KE-9); produksi: `<dataDir>/secrets`. */
  secrets?: SecretStore
  /** Pending-chat list owned by the caller so it survives a runtime rebuild (telegramHot.refresh). */
  pending?: PendingChatStore
}
