// Wire contract of the outbox endpoint, shared with the client (no server imports here).

export const OUTBOX_PATH = '/api/outbox'

/** Status of one outbox message as the API reports it. */
export type OutboxStatusName = 'queued' | 'delivered' | 'failed' | 'cancelled'

/** `POST /api/outbox` reply: the message (first one for a retried operationId) and whether it was a retry. */
export interface OutboxEnqueueReply { message: { id: string; status: OutboxStatusName }; deduped: boolean }
