// The "skill-author" preset of an Agent Chat node: the first message that turns a plain Claude chat into a
// skill co-author. The human reads it in the chat, so it doubles as the rule list they can hold the agent to.

/** Node `preset` value that makes a chat node a skill author. */
export const SKILL_AUTHOR_PRESET = 'skill-author'

// TOOL NARROWING IS NOT ENFORCED. The Agent Chat launcher (server/agentChat/agentChat.options.ts
// `buildAgentChatOptions`) takes no per-node allowedTools/disallowedTools, so a skill-author node has the same
// tools and permission mode as any other chat node. Building that mechanism is a server change outside this
// preset's scope; until it exists the limits below are INSTRUCTIONS to the agent, not a sandbox. What does hold
// regardless of the agent: it can only PROPOSE (`webterm skills`), a human approves, lint rejects unsafe text.
// Remove this note when the launcher gains a per-node tool allowlist and the preset uses it.

/** Limits mirrored from the skill lint (server/central/skills/skillLint.ts); the server stays the authority. */
const BODY_MAX = 4000
const DESCRIPTION_MAX = 300

const LOOP = [
  'Work in this order and do not skip a step.',
  '1. DISCUSS first. Ask what the skill is for, who will use it (Central or worker agents) and when it should trigger. Ask one or two questions at a time.',
  '2. Ask clarifying questions until the purpose is clear, then propose an OUTLINE (title, trigger line, numbered steps in one line each). Then STOP and wait for the human to say "go". Do not write the body and do not run any command before an explicit "go".',
  '3. Only after "go": write the body and run `webterm skills propose --name <webterm-slug> --description "<when to use>" --body-file -` with the body on stdin.',
  '4. When you are done, tell the human the draft is waiting for approval in the Skills tab. NEVER say or imply the skill is active, enabled or in use: only the human can approve it, and you cannot.',
  `Skill rules: a skill is instructions only. No shell commands, URLs, file paths or secrets (lint rejects them). Body at most ${BODY_MAX} characters, description at most ${DESCRIPTION_MAX}. If lint rejects the draft, fix the listed problem and propose again.`,
  'Use only `webterm skills ...` for this work; do not read or edit project files and do not open a browser.',
].join('\n')

/** First message of a skill-author chat: a new skill, or an edit of `target` (a full `webterm-` name). */
export function skillAuthorInstruction(target?: string): string {
  if (!target) return `You are helping me write a new webterm skill. ${LOOP}`
  return `You are helping me edit the webterm skill "${target}". Before anything else run \`webterm skills list ${target}\` to read its current body, then ask me what should change. In step 3 run \`webterm skills edit ${target} --body-file -\` (add --description if the trigger line changes) instead of propose. ${LOOP}`
}
