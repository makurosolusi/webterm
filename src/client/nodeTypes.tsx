// Peta tipe node React Flow. Konstanta MODUL, bukan objek yang dibentuk saat render: React Flow
// me-remount setiap node ketika identitas map ini berubah, dan remount terminal berarti kehilangan
// seluruh scrollback-nya.
import type { NodeProps } from '@xyflow/react'
import TerminalNode from './TerminalNode'
import AgentNode from './AgentNode'
import FilesNode from './FilesNode'
import EditorNode from './EditorNode'
import { read, readBinary, write } from './fsClient'
import type { Settings } from '../shared/settings'

export const nodeTypes = {
  terminal: TerminalNode,
  agent: AgentNode,
  files: FilesNode,
  // Editor menerima fs lewat prop (webterm tidak punya preload Electron); settings-nya datang di
  // data node, jalur yang sama dengan node lain — lihat `flowNodes` di App.
  editor: (p: NodeProps) => (
    <EditorNode
      {...p}
      read={read}
      write={write}
      readBinary={readBinary}
      openMarkdownPreview={(p.data as { settings?: Settings }).settings?.openMarkdownPreview}
    />
  ),
}
