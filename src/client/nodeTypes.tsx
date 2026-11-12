// Peta tipe node React Flow. Konstanta MODUL, bukan objek yang dibentuk saat render: React Flow
// me-remount setiap node ketika identitas map ini berubah, dan remount terminal berarti kehilangan
// seluruh scrollback-nya.
import type { NodeProps } from '@xyflow/react'
import TerminalNode from './TerminalNode'
import AgentNode from './AgentNode'
import FilesNode from './FilesNode'
import EditorNode from './EditorNode'
import DiffNode from './DiffNode'
import PlanNode from './PlanNode'
import AgentChatNode from './AgentChatNode'
import McpAppNode from './mcpapps/McpAppNode'
import { BrowserNodeType } from './BrowserNode.slots'
import { useLiveSettings, useSettingsUpdate } from './useSettings'
import { withTabPortal } from './tabLayout.portal'

export const nodeTypes = {
  terminal: withTabPortal(TerminalNode),
  agent: withTabPortal(AgentNode),
  // Claude without a terminal, shown as a chat (AgentChatNode.tsx, PLAN/AGENT-CHAT.md).
  agentChat: withTabPortal(AgentChatNode),
  files: withTabPortal(FilesNode),
  browser: withTabPortal(BrowserNodeType),
  // Working-tree diff + review notes (DiffNode.tsx); cwd comes from node data or the wired agent.
  diff: withTabPortal(DiffNode),
  // ⌘K intent -> DAG draft, approved by a human, then the map of its workers (PlanNode.tsx, F4-f).
  plan: withTabPortal(PlanNode),
  // MCP Apps `ui://` view in a sandboxed frame (mcpapps/McpAppNode.tsx, F6); node id = server app id.
  app: withTabPortal(McpAppNode),
  // Editor menerima fs lewat prop (webterm tidak punya preload Electron); settings-nya dari
  // context, bukan lagi dari data node — lihat `useLiveSettings`.
  //
  // `withTabPortal` sudah `memo`: inilah komponen yang dipanggil React Flow, jadi hanya di sini
  // re-render karena prop bisa dihentikan sebelum masuk subtree. `memo` di EditorNode sendiri
  // menutup jalur yang lain — perubahan settings menembus wrapper (langganan context ada
  // di dalamnya) tapi berhenti di EditorNode kalau `openMarkdownPreview` tidak ikut berubah.
  editor: withTabPortal(function EditorNodeType(p: NodeProps) {
    const settings = useLiveSettings()
    const update = useSettingsUpdate()
    return (
      <EditorNode
        {...p}
        openMarkdownPreview={settings.openMarkdownPreview}
        // The last Preview/Edit choice decides how the next Markdown file opens (no setting to hunt for).
        onPreviewChange={(openMarkdownPreview) => update({ openMarkdownPreview })}
      />
    )
  }),
}
