// A node's DOM root is its React Flow wrapper on the canvas, or its pane in tab mode (data-tab-node).
export const NODE_ROOT = '.react-flow__node, [data-tab-node]'

/** Node root holding `el`, or null. */
export const closestNodeRoot = (el: Element | null | undefined): HTMLElement | null => el?.closest<HTMLElement>(NODE_ROOT) ?? null

/** Id of the node whose root holds `el`. */
export const nodeIdOf = (el: Element | null | undefined): string | undefined => closestNodeRoot(el)?.dataset.id

/** Root element of node `id` (attribute lookup, so any id is safe without CSS.escape). Prefers the pane over the hidden canvas wrapper. */
export function findNodeRoot(id: string): HTMLElement | undefined {
  const all = Array.from(document.querySelectorAll<HTMLElement>(NODE_ROOT)).filter((e) => e.dataset.id === id)
  return all.find((e) => e.hasAttribute('data-tab-node')) ?? all[0]
}
