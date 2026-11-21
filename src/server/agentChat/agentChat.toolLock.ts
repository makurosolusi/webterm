// Server-enforced tool lock of an Agent Chat node with a preset (today only `skill-author`). The lock is
// derived from the node's stored preset, never from a client-sent list; an absent or unknown preset
// gets no lock (options unchanged).
//
// Layers (docs checked 2026-11-17, code.claude.com permissions / cli-reference / hooks, SDK 0.3.318):
//  1. `tools: ['Bash']` (`--tools=Bash`): the only built-in tool that exists in the session.
//  2. `strictMcpConfig` with no `--mcp-config`, `settingSources: []` (no user/project allow rules, hooks,
//     skills), `--disable-slash-commands`, no plugins.
//  3. `permissionMode: 'dontAsk'` + `permissionPrompts: 'none'`: whatever is not allowed is denied.
//     The allow rules `Bash(webterm skills *)` / `Bash(webterm browser *)` are only a convenience: the CLI matcher splits compound
//     commands on `&& || ; | |& &` and newlines, but heredoc bodies and quoting are NOT proven safe there.
//  4. A PreToolUse SDK callback (fail-closed, `onFailure: 'block'`) is the layer we can prove in a test:
//     it allows one strictly parsed command of two families and denies everything else, in every permission
//     mode: `skillsCommandDecision` (`webterm skills <verb> ...`) and `browserCommandDecision` (read-only
//     public web research: `webterm browser open|navigate|snapshot [url]`, agentChat.toolLock.browser.ts).
//  5. The server is the authority for the browser family: the browser control handler reads the calling node's
//     STORED preset and refuses other verbs / non-public URLs with 403 (browser/browser.presetLock.ts).
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { browserCommandDecision } from './agentChat.toolLock.browser'
import { grantedChatFamilies, type ChatFamily } from '../../shared/agentCapabilities'
import { isAgentChatPreset, type AgentChatPreset } from '../../shared/agentChat.shape'

/** `webterm skills` verbs the author may run (cli.skills.ts): read, propose, edit. */
const VERBS = 'list|get|propose|edit'
const WORD = '[A-Za-z0-9_.=:@,-]+'
const TOKEN = `(?:${WORD}|"[^"$\`\\\\\\n]*"|'[^'\\n]*')`
const HEADER = new RegExp(`^webterm skills (?:${VERBS})((?: +${TOKEN})*)(?: +<<'([A-Z][A-Z0-9_]{0,15})')?[ \\t]*$`)
const TOKEN_G = new RegExp(TOKEN, 'g')

export const DENY_REASON = 'Only one `webterm skills list|get|propose|edit ...` command or one `webterm browser open|navigate|snapshot [https-url]` command (public pages, read-only) is allowed. Pass the body with `--body-file -` and a quoted heredoc: `webterm skills propose --name x --description "..." --body-file - <<\'EOF\'` then the body, then a line `EOF`. No pipes, `;`, `&&`, `$()`, backticks or redirects.'

const unquote = (t: string): string => (t.startsWith('"') || t.startsWith("'") ? t.slice(1, -1) : t)

/** True when `command` is exactly one allowed `webterm skills` call (optionally with a quoted heredoc body). */
export function skillsCommandDecision(command: unknown): boolean {
  if (typeof command !== 'string' || /[\r\0]/.test(command)) return false
  const nl = command.indexOf('\n')
  const header = nl < 0 ? command : command.slice(0, nl)
  const m = HEADER.exec(header)
  if (!m) return false
  const tag = m[2]
  if (nl < 0) {
    if (tag) return false // heredoc operator with no body
  } else {
    if (!tag) return false // a second line without a heredoc would be a second command
    const lines = command.slice(nl + 1).split('\n')
    const end = lines.indexOf(tag)
    if (end < 0 || lines.slice(end + 1).some((l) => l.trim() !== '')) return false
  }
  // The body may only come from stdin: `--body-file <path>` would let the agent propose any readable file.
  const values = (m[1] ?? '').match(TOKEN_G)?.map(unquote) ?? []
  for (let k = 0; k < values.length; k++) {
    const v = values[k]!
    if (v === '--body-file' ? values[k + 1] !== '-' : v.startsWith('--body-file')) return false
  }
  return true
}

/** Strict parser per command family; WHICH families a chat may run comes from the capability registry. */
const FAMILY_DECISION: Readonly<Record<ChatFamily, (command: unknown) => boolean>> = { skills: skillsCommandDecision, browser: browserCommandDecision }
const AUTHOR_FAMILIES = grantedChatFamilies('chat.skill-author')
const allowedCommand = (c: unknown): boolean => AUTHOR_FAMILIES.some((f) => FAMILY_DECISION[f](c))

/** The SDK PreToolUse callback: allow a valid `webterm skills` / `webterm browser` Bash call, deny every other tool use. */
export const skillAuthorPreToolUse: HookCallback = async (input) => {
  const ok = input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash'
    && allowedCommand((input.tool_input as { command?: unknown } | null)?.command)
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: ok ? 'allowed webterm command' : DENY_REASON } }
}

/** Preset -> forced option fields; `undefined` = not locked. Pure, derived from the node's preset only. */
export function agentChatLockFor(preset: unknown): Partial<Options> | undefined {
  if (!isAgentChatPreset(preset) || preset === 'maintainer') return undefined // a maintainer chat is a plain chat: no lock
  const locks: Record<'skill-author', Partial<Options>> = {
    'skill-author': {
      tools: ['Bash'],
      allowedTools: AUTHOR_FAMILIES.map((f) => `Bash(webterm ${f} *)`),
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      strictMcpConfig: true,
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [skillAuthorPreToolUse], onFailure: 'block' }] },
    },
  }
  return locks[preset]
}
