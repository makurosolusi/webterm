// Penempel node browser ke React Flow: BrowserNode (WS-06) + toolbar/chip lease/dialog cookie
// (WS-09) lewat slot `renderToolbar`/`renderOverlay`. Komponen di sini dipanggil React Flow, jadi
// didaftarkan sebagai konstanta modul di `nodeTypes`.
import { memo, useCallback, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import BrowserNode from './BrowserNode'
import type { BrowserSlotCtx } from './BrowserNode'
import BrowserToolbar from './BrowserToolbar'
import BrowserLeaseChip from './BrowserLeaseChip'
import BrowserCookieDialog from './BrowserCookieDialog'
import { setAgentControl } from './browser.api'
import { useBrowserStatus } from './browser.feature'
import { getBrowserWorkspace } from './browser.stream'
import { COOKIE_TEXT } from './browser.uxText'

function BrowserSlots({ p, ctx }: { p: NodeProps; ctx: BrowserSlotCtx }) {
  const rf = useReactFlow()
  const status = useBrowserStatus()
  const [cookiesOpen, setCookiesOpen] = useState(false)
  const agentControl = (p.data as { agentControl?: boolean }).agentControl ?? false
  const onAgentControl = useCallback((enabled: boolean) => {
    // Server dulu: bila gagal, flag tersimpan tidak berubah dan toggle tetap menunjukkan kenyataan.
    void setAgentControl(p.id, enabled).then(() => rf.updateNodeData(p.id, { agentControl: enabled })).catch((e: unknown) => console.warn('browser.agentControl failed', e instanceof Error ? e.message : 'unknown'))
  }, [p.id, rf])
  return (
    <>
      <BrowserToolbar state={ctx.state} nav={ctx.nav} agentControl={agentControl} agentEnabled={status?.agentEnabled ?? false} onAgentControl={onAgentControl} zoom={ctx.zoom} onZoom={ctx.stepZoom} />
      {status?.cookieImportEnabled && (
        <>
          <Button size="xs" variant="ghost" className="nodrag self-start" onClick={() => setCookiesOpen(true)}>{COOKIE_TEXT.title}</Button>
          <BrowserCookieDialog cookieImportEnabled workspaceId={getBrowserWorkspace()} open={cookiesOpen} onClose={() => setCookiesOpen(false)} />
        </>
      )}
    </>
  )
}

/** Tipe node 'browser' untuk React Flow. */
export const BrowserNodeType = memo(function BrowserNodeType(p: NodeProps) {
  return (
    <BrowserNode
      {...p}
      renderToolbar={(ctx) => <BrowserSlots p={p} ctx={ctx} />}
      renderOverlay={(ctx) => <BrowserLeaseChip lease={ctx.state?.lease} onTakeover={ctx.takeover} />}
    />
  )
})
