// Client side of the "skill-author" preset of an Agent Chat node: display text only. The agent's real role
// prompt and tool lock are built SERVER-SIDE from the node's stored `preset` (server/agentChat/agentChat.role.ts,
// agentChat.toolLock.ts); nothing here is ever sent as a message.

/** Node `preset` value that makes a chat node a skill author. */
export const SKILL_AUTHOR_PRESET = 'skill-author'

/** Role banner at the top of a skill-author chat. */
export const SKILL_AUTHOR_BANNER = 'Skill author: designs and edits webterm skills with you. Tools locked to `webterm skills`. Drafts need your approval in the Skills tab.'

/** Why the permission mode chip reads "Locked" in a skill-author chat. */
export const SKILL_AUTHOR_LOCK_REASON = 'Locked by the Skill author role: the agent can only run `webterm skills` commands, whatever the mode.'
