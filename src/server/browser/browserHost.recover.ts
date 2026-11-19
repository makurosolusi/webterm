// Page commands that are safe to repeat and whose "gone page" answer (-32000 "Not attached to an active page") means the page is
// lost. There is no recovery by activating the target: that surfaces the OS window (see cdp.windowGuard.ts). A lost page is
// dropped (node) or marked crashed (tab) and the client shows Reload, which opens a fresh page on the last URL.
import { CDP } from './cdp.client'

/** Idempotent page commands the node needs to keep working; a gone-page answer to one of them loses the page. */
const RECOVERABLE: ReadonlySet<string> = new Set([CDP.startScreencast, CDP.stopLoading, CDP.getNavigationHistory])
export const isRecoverable = (method: string): boolean => RECOVERABLE.has(method)
