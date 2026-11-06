// Slash commands the Agent Chat answers itself instead of sending them to Claude. Claude Code's own
// UI opens a picker for `/model` and `/resume`; an SDK session has no such dialog, so the chat opens
// its footer pickers instead. `/clear` starts a new conversation through the node's own control.
import type { AgentChatCommand } from '../../shared/agentChat.wire'

export type ChatIntercept = 'model' | 'resume' | 'clear'

/** Command name (aliases included, as Claude Code spells them) -> what the chat does instead. */
const INTERCEPT: Record<string, ChatIntercept> = { model: 'model', resume: 'resume', continue: 'resume', clear: 'clear', reset: 'clear', new: 'clear' }

/** The local action for a message, or null to send it to Claude. Arguments after the command are ignored. */
export function interceptOf(text: string): ChatIntercept | null {
  const m = /^\s*\/([A-Za-z-]+)(?:\s|$)/.exec(text)
  const name = m?.[1].toLowerCase()
  return name && Object.hasOwn(INTERCEPT, name) ? INTERCEPT[name] : null
}

/** Menu entries for the intercepted pickers; an SDK catalog does not list them (they are TUI dialogs there). */
export const LOCAL_COMMANDS: readonly AgentChatCommand[] = [
  { name: 'model', description: 'Choose the model', builtin: true },
  { name: 'resume', description: 'Resume a past conversation', aliases: ['continue'], builtin: true },
]
