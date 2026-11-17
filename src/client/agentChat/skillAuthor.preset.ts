// Client side of the "skill-author" preset of an Agent Chat node: display text only. The agent's real role
// prompt and tool lock are built SERVER-SIDE from the node's stored `preset` (server/agentChat/agentChat.role.ts,
// agentChat.toolLock.ts); nothing here is ever sent as a message.

/** Node `preset` value that makes a chat node a skill author. */
export const SKILL_AUTHOR_PRESET = 'skill-author'

/** Role banner at the top of a skill-author chat. */
export const SKILL_AUTHOR_BANNER = 'Skill author: walks you through purpose, title, steps and checks before writing; drafts need your approval in the Skills tab.'

/** Why the permission mode chip reads "Locked" in a skill-author chat. */
export const SKILL_AUTHOR_LOCK_REASON = 'Locked by the Skill author role: the agent can only run `webterm skills` commands, whatever the mode. Can read public web pages (read-only).'

/** Compact role line of the chat header (the full explanation is the tooltip + SKILL_AUTHOR_BANNER). */
export const SKILL_AUTHOR_HEADER = 'Skill author · writes canvas skills only'

/** Composer hint of a skill-author chat while idle. */
export const SKILL_AUTHOR_PLACEHOLDER = 'Describe the procedure you want to turn into a skill'

/** Empty-state copy and click-to-fill starters. */
export const SKILL_AUTHOR_EMPTY = {
  title: 'What should this skill teach an agent?',
  hint: 'Pick a starter or describe it yourself. Drafts need your approval before they go live.',
  examples: [
    'Turn our release checklist into a skill: run tests, bump the version, update the changelog, tag.',
    'Write a skill for reviewing a pull request: what to read first, what to flag, how to report.',
    'Create a skill for triaging a failing test: reproduce, find the root cause, propose a fix.',
  ],
} as const

/** Inline card shown once the author has proposed or edited a draft. */
export const SKILL_AUTHOR_DRAFT = { text: 'Draft proposed - review in Control > Skills', open: 'Open Skills tab' } as const
