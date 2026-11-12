// Tombol header editor: kembali ke node Files yang membuka file ini. Editor bisa diseret jauh dari
// Files-nya; kabel `kind: 'file'` (dibuat useFilesOpen, dipersist toBridge) adalah satu-satunya jejak asalnya.
import { useCallback } from 'react'
import { useReactFlow, useStore, type ReactFlowState } from '@xyflow/react'
import { IconButton } from '@/components/ui/icon-button'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'

/** Sumber kabel file TERBARU (terakhir di array) yang menuju `editorId`, selama node sumbernya masih ada. */
export function filesSourceOf(s: Pick<ReactFlowState, 'edges' | 'nodeLookup'>, editorId: string): string | null {
  for (let i = s.edges.length - 1; i >= 0; i--) {
    const e = s.edges[i]
    if (e.target === editorId && (e.data as { kind?: string } | undefined)?.kind === 'file' && s.nodeLookup.has(e.source)) return e.source
  }
  return null
}

/** "Show in Files" for editor `editorId`: selects, reveals and focuses its source Files node; null when there is none. */
export function useShowInFiles(editorId: string): (() => void) | null {
  const rf = useReactFlow()
  // Selector sempit: hanya string id yang dibandingkan, jadi perubahan edge/node lain tidak me-render editor.
  const source = useStore(useCallback((s: ReactFlowState) => filesSourceOf(s, editorId), [editorId]))
  if (!source) return null
  return () => {
    const n = rf.getNode(source)
    if (!n) return
    selectOnly(rf, source)
    revealNode(rf, source, rectOfNode(n))
  }
}

/** "Show in Files" header button; tersembunyi bila tak ada node Files asal. */
export function ShowInFilesButton({ editorId }: { editorId: string }) {
  const show = useShowInFiles(editorId)
  if (!show) return null
  return (
    <IconButton size="icon-xs" className="nodrag" label="Show in Files" onClick={show}>
      <span className="codicon codicon-folder-opened" aria-hidden="true" />
    </IconButton>
  )
}
