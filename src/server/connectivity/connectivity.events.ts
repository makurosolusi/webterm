// What a state CHANGE becomes: a Senses event and a `t:'net'` WebSocket frame. Class names and timestamps only
// (never a URL, host, header or credential), so both are safe to persist and to send to every window.
import type { AppendEventInput } from '../events/eventModel'
import type { NetMsg } from '../../shared/protocol'
import type { StateChange } from './connectivity.service'

/** Senses kind announced on every state change. */
export const CONNECTIVITY_EVENT_KIND = 'connectivity.changed'

export function changeEvent({ from, to, state }: StateChange): AppendEventInput {
  return {
    kind: CONNECTIVITY_EVENT_KIND, source: 'connectivity', trust: 'trusted',
    payload: { from, to, since: state.since, ...(state.cause ? { cause: state.cause } : {}), ...(state.scope ? { scope: state.scope } : {}) },
  }
}

export function netFrame({ state }: StateChange): NetMsg {
  return { t: 'net', v: 1, state: state.state, since: state.since, ...(state.cause ? { cause: state.cause } : {}), ...(state.scope ? { scope: state.scope } : {}) }
}
