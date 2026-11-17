// Tells the Skills tab that a Central skill-author chat finished a turn, so its Drafts panel refreshes without polling.
// A window event (not a module store): the chat pane and the Skills tab live in different React trees.

/** Window event name. */
export const CENTRAL_SKILL_AUTHOR_ACTIVITY = 'webterm:central-skill-author-activity'

export const notifyCentralSkillAuthorActivity = (): void => {
  window.dispatchEvent(new CustomEvent(CENTRAL_SKILL_AUTHOR_ACTIVITY))
}

/** Calls `fn` when a Central skill-author chat reports a finished turn; returns the unsubscribe. */
export function onCentralSkillAuthorActivity(fn: () => void): () => void {
  window.addEventListener(CENTRAL_SKILL_AUTHOR_ACTIVITY, fn)
  return () => window.removeEventListener(CENTRAL_SKILL_AUTHOR_ACTIVITY, fn)
}
