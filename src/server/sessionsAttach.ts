import { randomBytes } from 'node:crypto'
import type { ReplayFrom, ServerMsg } from '../shared/protocol'
import type { Session } from './sessionsTypes'

/** What a client sees when it (re)attaches to a live session: its replay and the kind gate. */

type Send = (m: ServerMsg) => void

// Per process: a session adopted after a server restart gets a fresh log, so it must not share an
// epoch with the log a client saw before the restart.
const BOOT_ID = randomBytes(4).toString('hex')
let epochs = 0

/** A new epoch for a new session log. */
export function nextEpoch(): string {
  return `${BOOT_ID}-${++epochs}`
}

/**
 * Replay a live session to ONE subscriber. When `since` names this session's log and every chunk
 * after it is still stored, only that gap is sent: the client's screen already holds the rest.
 * Otherwise `reset` first (the client clears its screen and seq), then the whole stored log.
 */
export function replay(session: Session, send: Send, since?: ReplayFrom): void {
  const { log } = session
  const from = since && since.epoch === session.epoch && since.seq >= log.floorSeq() - 1 && since.seq <= log.lastSeq() ? since.seq : undefined
  if (from === undefined) send({ t: 'reset', id: session.id, epoch: session.epoch })
  for (const chunk of log.since(from ?? 0)) send({ t: 'output', id: session.id, data: chunk.data, seq: chunk.seq })
}

/** Same session kind: the same agent, or both plain terminals. */
export function sameKind(held: string | undefined, asked: string | undefined): boolean {
  return (held ?? '') === (asked ?? '')
}

const kindName = (agentId: string | undefined): string => (agentId ? `the ${agentId} agent` : 'a plain terminal')

export function kindMismatchNotice(held: string | undefined, asked: string | undefined): string {
  return `\r\n[webterm] This node's session is already running ${kindName(held)}, so it was not opened as ${kindName(asked)}. Close this node and add a new one.\r\n`
}

/** Refuse an open whose kind differs from the live session under its id (pty-207-6): the caller
 *  alone gets the notice and an `exit`, and is never subscribed to the other kind's output. */
export function refuseKind(id: string, held: string | undefined, asked: string | undefined, send: Send): void {
  send({ t: 'output', id, data: kindMismatchNotice(held, asked) })
  send({ t: 'exit', id, code: -1, reason: 'kind_mismatch' })
}
