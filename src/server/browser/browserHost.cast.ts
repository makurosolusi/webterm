// Screencast start/stop that tolerate Chromium's own state. Chromium answers `Page.startScreencast` on a page that
// already streams with -32000 "Screencast is already active" (a side-pane stream promoted to the view, a re-sent view,
// a wake racing a resume); that is the state we wanted, not a failure. Chromium is the source of truth, so every
// caller goes through here instead of tracking a second copy of "is it streaming" that can drift.
import { createLogger } from '../logs'
import { CDP, CdpCommandError } from './cdp.client'

const log = createLogger('browser.cast')

type Send = (method: string, params?: object) => Promise<unknown>

const cdpMessage = (e: unknown): string => (e instanceof CdpCommandError && e.code === -32000 ? e.cdpMessage : '')
export const isAlreadyActive = (e: unknown): boolean => /already active/i.test(cdpMessage(e))
export const isNotActive = (e: unknown): boolean => /not (been )?(active|started)/i.test(cdpMessage(e))

/** Start a stream; one already running is restarted so it takes the new size/rate. Any other failure is thrown. */
export async function startCast(send: Send, params: object, ctx: string): Promise<void> {
  try {
    await send(CDP.startScreencast, params)
  } catch (err) {
    if (!isAlreadyActive(err)) throw err
    log.debug('browser.cast', 'screencast already active, restarting it', { ctx })
    await stopCast(send, ctx)
    await send(CDP.startScreencast, params)
  }
}

/** Stop a stream; one that is not running counts as stopped. Any other failure is thrown. */
export async function stopCast(send: Send, ctx: string): Promise<void> {
  try {
    await send(CDP.stopScreencast)
  } catch (err) {
    if (!isNotActive(err)) throw err
    log.debug('browser.cast', 'screencast was not active', { ctx })
  }
}

/** Stop then start (new size/rate); the stop of a stream that is not running is not an error. */
export async function restartStream(send: Send, params: object, ctx: string): Promise<void> {
  await stopCast(send, ctx)
  await startCast(send, params, ctx)
}
