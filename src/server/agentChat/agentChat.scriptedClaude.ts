// Test-only: a scripted fake Claude for end-to-end and browser checks of the agent chat node. Each
// user prompt plays one turn: init, a requesting status, streamed text, one Bash tool use that asks
// for permission through the real canUseTool, the tool result, a closing answer and the result. A
// prompt containing SCRIPTED_FAIL_WORD makes the stream throw instead; an interrupt ends the turn as
// the CLI does, with an error_during_execution result. Never imported by production code; no real
// Claude process is involved.
import type { CanUseTool, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AgentChatOpen } from './agentChat.options'
import { FakeQuery, fx } from './agentChat.fakeQuery'

export const SCRIPTED_SESSION_ID = 'fake-session-0001'
export const SCRIPTED_MODEL = 'claude-fake'
export const SCRIPTED_TOOL_INPUT = { command: 'ls', description: 'List files in the folder' }
export const SCRIPTED_TOOL_OUTPUT = 'README.md\nsrc'
export const SCRIPTED_INTRO = ['Let me look ', 'at the folder.']
export const SCRIPTED_ANSWER = 'The folder has a README and a src directory.'
export const SCRIPTED_FAIL_WORD = 'crash'
export const SCRIPTED_FAIL_MESSAGE = 'Fake Claude crashed'
/** "Always allow" offer of the scripted permission prompt. */
export const SCRIPTED_SUGGESTIONS: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]

/** One opened fake Query: what the session passed in, and what it did to it. */
export interface ScriptedOpen { fq: FakeQuery; resume?: string; abort: AbortController; prompts: string[]; id: string }

/** Tool use id of turn `turn` (from 1) of an open: ids are unique across opens and restarts, like the CLI's. */
export const scriptedToolId = (o: ScriptedOpen, turn: number): string => `tu-${o.id}-${turn}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const empty = (async function* (): AsyncGenerator<SDKUserMessage> {})()
const promptText = (p: SDKUserMessage): string => (typeof p.message.content === 'string' ? p.message.content : JSON.stringify(p.message.content))

/** Opener playing the script; `stepMs` slows the stream down so a browser can see it in flight. */
export function scriptedClaude(o: { stepMs?: number } = {}): { opener: AgentChatOpen; opens: ScriptedOpen[] } {
  const opens: ScriptedOpen[] = []
  const step = () => (o.stepMs ? sleep(o.stepMs) : Promise.resolve())
  const opener: AgentChatOpen = (resume, canUseTool, abort, input) => {
    // The FakeQuery gets no prompt of its own: the turns below read the session's prompt instead.
    const fq = new FakeQuery(empty)
    const x: ScriptedOpen = { fq, abort, prompts: [], id: randomUUID().slice(0, 8), ...(resume ? { resume } : {}) }
    opens.push(x)
    // One controller per turn: an interrupt cancels the open prompt (as the CLI does) and ends the turn.
    let turnCtl = new AbortController()
    const countInterrupt = fq.interrupt.bind(fq)
    fq.interrupt = async () => {
      await countInterrupt()
      turnCtl.abort()
      fq.emit(fx.result({ subtype: 'error_during_execution', isError: true }))
    }
    abort.signal.addEventListener('abort', () => turnCtl.abort(), { once: true })
    void (async () => {
      let turn = 0
      for await (const p of input.prompt) {
        x.prompts.push(promptText(p))
        turnCtl = new AbortController()
        if (abort.signal.aborted) return
        await playTurn(fq, canUseTool, turnCtl.signal, ++turn, `${x.id}-${turn}`, promptText(p), input.mode ?? 'manual', step)
      }
    })().catch((err: unknown) => fq.fail(err instanceof Error ? err : new Error(String(err))))
    return fq.asQuery()
  }
  return { opener, opens }
}

async function playTurn(
  fq: FakeQuery, canUseTool: CanUseTool, signal: AbortSignal, turn: number, tag: string, text: string, mode: string, step: () => Promise<void>,
): Promise<void> {
  const gone = (): boolean => signal.aborted
  if (gone()) return
  fq.emit(fx.init(SCRIPTED_SESSION_ID, SCRIPTED_MODEL, mode === 'manual' ? 'default' : mode))
  if (text.includes(SCRIPTED_FAIL_WORD)) {
    fq.fail(new Error(SCRIPTED_FAIL_MESSAGE))
    return
  }
  const intro = `m-${tag}-a`
  const toolId = `tu-${tag}`
  fq.emit(fx.status({ status: 'requesting' }), fx.messageStart(intro))
  for (const chunk of SCRIPTED_INTRO) {
    fq.emit(fx.textDelta(chunk))
    await step()
    if (gone()) return
  }
  fq.emit(fx.assistant(intro, [{ type: 'text', text: SCRIPTED_INTRO.join('') }]))
  fq.emit(fx.assistant(intro, [{ type: 'tool_use', id: toolId, name: 'Bash', input: SCRIPTED_TOOL_INPUT }]))
  let answer: PermissionResult | null
  try {
    answer = await canUseTool('Bash', { ...SCRIPTED_TOOL_INPUT }, {
      signal, toolUseID: toolId, requestId: `req-${tag}`, suggestions: SCRIPTED_SUGGESTIONS,
    })
  } catch (err) {
    if (gone()) return // closed or interrupted while waiting: the session already resolved the prompt
    throw err
  }
  if (gone()) return
  // The session promises never to answer null (agentChat.session.ts canUseTool).
  if (!answer) throw new Error('scripted turn: canUseTool answered null')
  fq.emit(answer.behavior === 'allow' ? fx.toolResult(toolId, SCRIPTED_TOOL_OUTPUT) : fx.toolResult(toolId, answer.message, true))
  const closing = `m-${tag}-b`
  fq.emit(fx.messageStart(closing))
  await step()
  if (gone()) return
  fq.emit(fx.textDelta(SCRIPTED_ANSWER))
  fq.emit(fx.assistant(closing, [{ type: 'text', text: SCRIPTED_ANSWER }]))
  fq.emit(fx.result({ cost: 0.01 * turn, denials: answer.behavior === 'deny' ? 1 : 0 }))
}
