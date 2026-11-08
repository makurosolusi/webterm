// Names the open board's nodes ("Mango") in one place, whatever path created them. Runs the same
// pure `withNodeNames` the server runs on save, over the React Flow array order (the order
// `toWsNode` saves), so client and server compute the same names.
import { useEffect } from 'react'
import type { Node, NodeChange } from '@xyflow/react'
import { withNodeNames } from '../shared/nodeNames'

const nameOf = (n: Node): string | undefined => (n.data as { name?: string }).name

/** `replace` changes for the nodes whose name is missing or a duplicate; empty once every name is settled. */
export function nodeNameChanges(nodes: readonly Node[]): NodeChange[] {
  const named = withNodeNames(nodes.map((n) => ({ id: n.id, name: nameOf(n) })))
  return nodes.flatMap((n, i): NodeChange[] =>
    named[i].name === nameOf(n) ? [] : [{ type: 'replace', id: n.id, item: { ...n, data: { ...n.data, name: named[i].name } } }],
  )
}

/** Writes missing names through `onNodesChange`, so the save that data edits schedule persists them. Settled boards emit nothing (no loop). */
export function useBoardNodeNames(nodes: readonly Node[], onNodesChange: (changes: NodeChange[]) => void): void {
  useEffect(() => {
    const changes = nodeNameChanges(nodes)
    if (changes.length) onNodesChange(changes)
  }, [nodes, onNodesChange])
}
