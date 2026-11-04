// Penempel node browser ke React Flow: BrowserNode (WS-06) + toolbar/chip lease (slot `renderToolbar`/
// `renderOverlay`) + dialog cookie yang dibuka dari menu ⋯ header (`menuItems`). Komponen di sini dipanggil React Flow, jadi
// didaftarkan sebagai konstanta modul di `nodeTypes`.
import { memo, useCallback, useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import BrowserNode from './BrowserNode'
import type { BrowserSlotCtx } from './BrowserNode'
import BrowserToolbar from './BrowserToolbar'
import BrowserLeaseChip from './BrowserLeaseChip'
import BrowserCookieDialog from './BrowserCookieDialog'
import { setAgentControl } from './browser.api'
import { useBrowserStatus } from './browser.feature'
import { getBrowserWorkspace } from './browser.stream'
import { COOKIE_MENU_TEXT as M } from './browser.uxText'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { useLiveSettings } from './useSettings'
import { toSearchEngine } from '../shared/browser.omnibox'

function BrowserSlots({ p, ctx }: { p: NodeProps; ctx: BrowserSlotCtx }) {
  const rf = useReactFlow()
  const status = useBrowserStatus()
  const searchEngine = toSearchEngine(useLiveSettings().browserSearchEngine)
  const agentControl = (p.data as { agentControl?: boolean }).agentControl ?? false
  const onAgentControl = useCallback((enabled: boolean) => {
    // Server dulu: bila gagal, flag tersimpan tidak berubah dan toggle tetap menunjukkan kenyataan.
    void setAgentControl(p.id, enabled).then(() => rf.updateNodeData(p.id, { agentControl: enabled })).catch((e: unknown) => console.warn('browser.agentControl failed', e instanceof Error ? e.message : 'unknown'))
  }, [p.id, rf])
  return <BrowserToolbar state={ctx.state} nav={ctx.nav} agentControl={agentControl} agentEnabled={status?.agentEnabled ?? false} onAgentControl={onAgentControl} zoom={ctx.zoom} onZoom={ctx.stepZoom} searchEngine={searchEngine} />
}

/** Submenu "Import Cookies ▸ From File…" + catatan Google, meniru menu ⋯ browser Orca. Satu-satunya pintu ke dialog cookie. */
function cookieMenuItems(onFromFile: () => void): VscodeMenuItem[] {
  return [{
    type: 'item', id: 'import-cookies', label: M.importCookies,
    submenu: [
      { type: 'item', id: 'import-cookies-file', label: M.fromFile, onSelect: onFromFile },
      { type: 'separator' },
      { type: 'header', label: M.googleNote },
    ],
  }]
}

/** Tipe node 'browser' untuk React Flow. */
export const BrowserNodeType = memo(function BrowserNodeType(p: NodeProps) {
  const status = useBrowserStatus()
  const [cookiesOpen, setCookiesOpen] = useState(false)
  const cookieOn = status?.cookieImportEnabled ?? false
  const menuItems = useMemo(() => (cookieOn ? cookieMenuItems(() => setCookiesOpen(true)) : undefined), [cookieOn])
  return (
    <>
      <BrowserNode
        {...p}
        menuItems={menuItems}
        renderToolbar={(ctx) => <BrowserSlots p={p} ctx={ctx} />}
        renderOverlay={(ctx) => <BrowserLeaseChip lease={ctx.state?.lease} onTakeover={ctx.takeover} />}
      />
      {cookieOn && <BrowserCookieDialog cookieImportEnabled workspaceId={getBrowserWorkspace()} open={cookiesOpen} onClose={() => setCookiesOpen(false)} />}
    </>
  )
})
