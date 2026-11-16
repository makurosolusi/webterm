// Pure rule for discarding a hidden browser node's page to free memory.

export interface DiscardInput {
  /** The page is mid-load (discarding would replay a half-finished navigation). */
  loading: boolean
  /** An agent holds a control lease: the page is in use even while hidden. */
  driven: boolean
  /** How long the node has been hidden. */
  hiddenMs: number
  /** Minimum hidden time before a discard is allowed. */
  discardMs: number
}

/**
 * True when the page may be dropped: idle, not driven by an agent, and hidden for at least
 * `discardMs`. Callers re-read the inputs when their timer fires, not when it was armed.
 * A non-finite duration compares false, so a bad number never triggers a discard.
 */
export function shouldDiscard({ loading, driven, hiddenMs, discardMs }: DiscardInput): boolean {
  if (loading || driven) return false
  return hiddenMs >= discardMs
}
