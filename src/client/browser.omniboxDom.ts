// DOM bridge to a node's one real address field: pages inside the node (start page, new-tab page) never own an address
// input, they hand focus and typing to the toolbar's omnibox so the node has a single address field.

/** The node's toolbar address field (`data-browser-omnibox`, also the ⌘L target), or null when the node has no toolbar. */
export const omniboxOf = (el: HTMLElement): HTMLInputElement | null =>
  el.closest('.browser-node')?.querySelector<HTMLInputElement>('[data-browser-omnibox]') ?? null
