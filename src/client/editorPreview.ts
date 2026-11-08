// Editor preview ala VS Code: node editor yang dibuka satu-klik dari Files berjudul miring dan
// dipakai ulang oleh klik berikutnya (`planFileOpen`). Ia jadi pinned saat pengguna mengedit,
// double-click judulnya, atau membuka file yang sama dengan Enter/menu (`useFilesOpen`).
import { useEffect } from 'react'
import { useReactFlow } from '@xyflow/react'

/** `preview` node editor `id` + `pin()`. Editan pertama mem-pin otomatis, jadi editor preview selalu bersih. */
export function useEditorPreview(id: string, preview: boolean, dirty: boolean) {
  const rf = useReactFlow()
  const pin = () => { if (preview) rf.updateNodeData(id, { preview: undefined }) }
  useEffect(() => { if (dirty && preview) rf.updateNodeData(id, { preview: undefined }) }, [dirty, preview, id, rf])
  return { preview, pin }
}
