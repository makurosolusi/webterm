// Peta tipe node React Flow. Konstanta MODUL, bukan objek yang dibentuk saat render: React Flow
// me-remount setiap node ketika identitas map ini berubah, dan remount terminal berarti kehilangan
// seluruh scrollback-nya.
import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import TerminalNode from './TerminalNode'
import AgentNode from './AgentNode'
import FilesNode from './FilesNode'
import EditorNode from './EditorNode'
import { read, readBinary, write } from './fsClient'
import { useLiveSettings } from './useSettings'

export const nodeTypes = {
  terminal: TerminalNode,
  agent: AgentNode,
  files: FilesNode,
  // Editor menerima fs lewat prop (webterm tidak punya preload Electron); settings-nya dari
  // context, bukan lagi dari data node — lihat `useLiveSettings`.
  //
  // Wrapper-nya ikut di-`memo`: inilah komponen yang dipanggil React Flow, jadi hanya di sini
  // re-render karena prop bisa dihentikan sebelum masuk subtree. `memo` di EditorNode sendiri
  // menutup jalur yang lain — perubahan settings menembus `memo` wrapper (langganan context ada
  // di dalamnya) tapi berhenti di EditorNode kalau `openMarkdownPreview` tidak ikut berubah.
  editor: memo(function EditorNodeType(p: NodeProps) {
    const settings = useLiveSettings()
    return (
      <EditorNode
        {...p}
        read={read}
        write={write}
        readBinary={readBinary}
        openMarkdownPreview={settings.openMarkdownPreview}
      />
    )
  }),
}
