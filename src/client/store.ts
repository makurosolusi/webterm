// Pure localStorage-backed layout persistence. Functions take a Storage-like
// object so they are testable in Node without a DOM.

export interface TermNode { id: string; x: number; y: number }

const KEY = 'webterm.nodes'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function loadNodes(storage: Store): TermNode[] {
  const raw = storage.getItem(KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveNodes(storage: Store, nodes: TermNode[]): void {
  storage.setItem(KEY, JSON.stringify(nodes))
}

export function addNode(nodes: TermNode[], node: TermNode): TermNode[] {
  return [...nodes, node]
}

export function removeNode(nodes: TermNode[], id: string): TermNode[] {
  return nodes.filter((n) => n.id !== id)
}
