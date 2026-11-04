// Attention policy for pushing inbox items off the canvas (Telegram), pure. Port of Orca's rules:
//  - suppress while the user is looking: src/main/notifications/notification-delivery-service.ts:136-144
//  - muted workspaces get no unread/banner/push: src/renderer/src/attention/agent-attention-policy.ts:60-64
//  - news a human does not need goes elsewhere (`coordinatorOnlyNews`, agent-attention-policy.ts:15);
//    here plain notify news waits for the daily digest instead of pinging (PLAN/rnd/04 §3 #4).
// The browser-side counterpart (OS banners) is `src/client/osNotify.ts`; both read the same mute list.
import type { InboxEntry } from './inboxItemModel'

/** push = send now; hold = not now, ask again next sweep; skip = never push this item. */
export type Attention = 'push' | 'hold' | 'skip'

export interface AttentionContext {
  /** Is the user looking at webterm (and so at this item's node) right now? */
  watching(item: Pick<InboxEntry, 'nodeId' | 'workspaceId'>): boolean
  muted(workspaceId: string): boolean
}

export function attentionFor(item: Pick<InboxEntry, 'kind' | 'source' | 'nodeId' | 'workspaceId'>, ctx: AttentionContext): Attention {
  if (item.kind === 'notify' && item.source !== 'digest') return 'skip'
  // The user wrote these notes a moment ago on the canvas: the item is for visibility, never a ping.
  if (item.source === 'diff-notes') return 'skip'
  // A gate blocks an agent until a human answers; muting news must not deadlock work, so gates
  // ignore the mute (Orca mutes news, its decision gates still need the human).
  if (item.kind !== 'gate' && item.workspaceId && ctx.muted(item.workspaceId)) return 'skip'
  if (ctx.watching(item)) return 'hold'
  return 'push'
}
