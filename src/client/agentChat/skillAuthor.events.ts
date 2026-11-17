// Tells the Skills tab that a skill-author chat finished a turn, so its drafts panel refreshes without polling.
// A window event (not a module store): the chat node and the Skills tab live in different React trees.

/** Window event name; `detail.nodeId` is the chat node that went idle. */
export const SKILL_AUTHOR_ACTIVITY = 'webterm:skill-author-activity'

export const notifySkillAuthorActivity = (nodeId: string): void => {
  window.dispatchEvent(new CustomEvent(SKILL_AUTHOR_ACTIVITY, { detail: { nodeId } }))
}

/** Calls `fn` when `nodeId` reports activity; returns the unsubscribe. */
export function onSkillAuthorActivity(nodeId: string, fn: () => void): () => void {
  const h = (e: Event): void => { if ((e as CustomEvent<{ nodeId?: string }>).detail?.nodeId === nodeId) fn() }
  window.addEventListener(SKILL_AUTHOR_ACTIVITY, h)
  return () => window.removeEventListener(SKILL_AUTHOR_ACTIVITY, h)
}
