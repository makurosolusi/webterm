// Parks the worker result of a Stop/StopFailure hook for the work watcher (workResult.ts). Split from
// `agentStatusApi.ts`; the hook route only decides WHEN to call it.
import { createLogger } from './logs'
import { captureFromHook, noResult, stashStopResult } from './central/work/workResult'
import { readTranscriptFile } from './contextLinkTranscript'

const log = createLogger('hooks')

/** Result reason when the hook body passed the cap and carried no usable message in its prefix. */
export const PAYLOAD_TOO_LARGE = 'payload_too_large'

/**
 * Stashes the capture of a node's own Stop/StopFailure (`trusted` = the request carried that node's
 * token). An oversize body keeps the readable head of its message, flagged `truncated`; with none it
 * leaves an explicit `none:payload_too_large` result instead of silence. Never stores for other events.
 */
export function stashHookStop(nodeId: string, event: string | undefined, body: Record<string, unknown>, transcript: string | undefined, trusted: boolean, oversize = false): void {
  if (!trusted || (event !== 'Stop' && event !== 'StopFailure')) return
  const at = Date.now()
  if (oversize && event === 'Stop' && typeof body.last_assistant_message !== 'string') {
    stashStopResult(nodeId, noResult(PAYLOAD_TOO_LARGE, at))
    return
  }
  const result = captureFromHook(body, at, transcript, (p) => {
    const raw = readTranscriptFile(p)
    if (raw === null) log.warn('hooks.result_transcript', 'Stop payload had no message and the transcript tail was unreadable', { ids: { nodeId } })
    return raw
  })
  stashStopResult(nodeId, oversize && result.source !== 'none' ? { ...result, truncated: true } : result)
}
