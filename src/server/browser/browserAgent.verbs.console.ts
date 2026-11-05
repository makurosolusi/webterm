// Agent read verb `console`: the newest page console entries of a browser node (errors first of all), so an agent
// wired to the browser can see why a page broke. Reads the host's buffer; no CDP call, so the agent CDP allowlist
// is untouched. Text is page content: wrapped as untrusted like `snapshot`.
import { CONSOLE_BUFFER_MAX, CONSOLE_LEVELS, sourceLabel } from '../../shared/browser.console'
import type { ConsoleEntry, ConsoleLevel } from '../../shared/browser.console'
import { asRecord, badRequest, stateOf } from './browserAgent.verbs.ctx'
import type { AgentCtx, AgentVerbs } from './browserAgent.verbs.ctx'
import { wrapUntrusted } from './browserAgent.wrap'
import { BrowserError } from './browserHost.targets'

/** Entries returned when the agent passes no `limit`. */
export const CONSOLE_VERB_DEFAULT_LIMIT = 50

/** One entry as a text line: `[error] Uncaught TypeError: x (app.js:12)` plus indented stack frames. */
export function entryLine(e: ConsoleEntry): string {
  const src = sourceLabel(e.url, e.line)
  const head = `[${e.level}${e.source === 'console' ? '' : `/${e.source}`}] ${e.text}${src ? ` (${src})` : ''}`
  return [head, ...(e.stack ?? []).map((f) => `    at ${f.fn} (${f.url}:${f.line}:${f.col})`)].join('\n')
}

export function consoleVerbs(ctx: AgentCtx): Pick<AgentVerbs, 'console'> {
  return {
    async console(nodeId, raw) {
      const body = asRecord(raw)
      stateOf(ctx, nodeId)
      const { limit, level } = body
      if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= CONSOLE_BUFFER_MAX)) throw badRequest(`limit must be an integer within 1..${CONSOLE_BUFFER_MAX}`)
      if (level !== undefined && !CONSOLE_LEVELS.includes(level as ConsoleLevel)) throw badRequest(`level must be one of ${CONSOLE_LEVELS.join(', ')}`)
      if (!ctx.console) throw new BrowserError('disabled', `node ${nodeId}: console capture is not running`)
      ctx.leases.touch(nodeId)
      const r = ctx.console.read(nodeId, (limit as number | undefined) ?? CONSOLE_VERB_DEFAULT_LIMIT, (level as ConsoleLevel | undefined) ?? 'info')
      return { content: wrapUntrusted(r.entries.map(entryLine).join('\n')), count: r.entries.length, dropped: r.dropped }
    },
  }
}
