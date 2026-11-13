// What the native app tells the user when its session cannot open (main.ts shows it in a native error box,
// then quits). Pure, so the wording is testable without Electrobun. Never carries a token or a sign-in code:
// the error messages it quotes name only the data dir, origin, pid and HTTP status.
import { AlreadyRunningError } from '../server/instanceGuard'
import { AttachRefusedError } from './nativeSession'

/** Title + one-line message + detail for the error box. */
export interface ErrorDialog { title: string; message: string; detail: string }

const TITLE = 'webterm'

/** The dialog for a failed `openNativeSession`: a server that refused to attach, the single-instance guard, or any other start failure. */
export function sessionErrorDialog(err: unknown): ErrorDialog {
  const detail = err instanceof Error ? err.message : String(err)
  if (err instanceof AlreadyRunningError) return { title: TITLE, message: 'webterm is already running for this data folder.', detail }
  if (err instanceof AttachRefusedError) return { title: TITLE, message: 'The running webterm server would not open a window.', detail }
  return { title: TITLE, message: 'webterm could not start.', detail }
}
