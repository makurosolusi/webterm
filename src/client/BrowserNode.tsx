import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import type { NodeProps } from '@xyflow/react'
import { NAV_ACTIONS, ZOOM_PAUSE_BELOW } from '../shared/browser.contract'
import type { BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'
import type { BrowserErr } from './browser.status'
import type { Comment } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import BrowserSurface from './browser.surface'
import { useBrowserSession } from './browser.useSession'
import { browserStream } from './browser.stream'
import { useNodeActions } from './nodeActions'
import { isBlankUrl, shouldMirrorUrl, useGoto } from './browser.useGoto'
import BrowserStartPage from './BrowserStartPage'
import { addRecent } from './browser.recent'
import { ZOOM_DEFAULT, stepZoom } from './browser.zoom'
import { randomId } from './randomId'
import { useLiveSettings } from './useSettings'
import { toSearchEngine } from '../shared/browser.omnibox'
import { resolveDevice } from '../shared/browser.devices'
import type { DeviceChoice } from '../shared/browser.devices'
import BrowserDeviceHeader from './BrowserDeviceHeader'
import { deviceStyle, useDeviceSession } from './browser.device'
import { useConsoleDrawer } from './BrowserConsole'
import type { ConsoleSlot } from './BrowserConsole'
import './browser.css'

const COLLAPSED_H = 40
const DEFAULT_H = 400
const DEFAULT_TITLE = 'Browser'

/** Konteks untuk slot UI (toolbar URL, chip lease; ditempel WS-11 dari komponen WS-09). */
export interface BrowserSlotCtx {
  id: string
  state?: BrowserState
  /** Galat terakhir sesi (pesan overlay); dipakai slot untuk tombol pemulihan. */
  error?: BrowserErr
  /** URL yang terakhir diminta (ketikan toolbar / data node); saat diblokir, state.url masih halaman lama. */
  target?: string
  nav: (action: (typeof NAV_ACTIONS)[number], url?: string) => void
  takeover: () => void
  /** Zoom halaman (1 = 100%) dan langkahnya; murni klien, lihat browser.zoom.ts. */
  zoom: number
  stepZoom: (dir: -1 | 1) => void
  /** Nyalakan/matikan Shields untuk situs halaman ini. */
  setShields: (on: boolean) => void
  /** Device mode saved on the node (absent = Responsive) and its setter (null = Responsive). */
  device?: DeviceChoice
  setDevice: (device: DeviceChoice | null) => void
  /** Console drawer toggle + error badge count. */
  console?: ConsoleSlot
}

export interface BrowserNodeProps extends NodeProps {
  /** Dirender di atas permukaan (mis. toolbar URL). */
  renderToolbar?: (ctx: BrowserSlotCtx) => ReactNode
  /** Dirender menimpa permukaan (mis. chip "agent mengemudi"). */
  renderOverlay?: (ctx: BrowserSlotCtx) => ReactNode
  /** Item tambahan menu "⋯" header node (mis. Import Cookies). */
  menuItems?: VscodeMenuItem[]
}

/**
 * Node browser sungguhan: canvas yang menggambar screencast Chromium server-side dan meneruskan
 * input manusia. Berhenti menerima frame saat collapse atau zoom canvas < `ZOOM_PAUSE_BELOW`
 * (frame terakhir tetap terlihat). Tidak didaftarkan di `nodeTypes` di sini (WS-11).
 */
function BrowserNode({ id, data, selected, height, renderToolbar, renderOverlay, menuItems }: BrowserNodeProps) {
  const d = data as { url?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[]; device?: DeviceChoice }
  const rf = useReactFlow()
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []
  const lowZoom = useStore((s) => s.transform[2] < ZOOM_PAUSE_BELOW)
  const { openBrowserAt } = useNodeActions()
  // Popup sah (window.open / target=_blank) dari halaman ini: node baru di sebelahnya, seperti tab baru di Brave/Chrome.
  const session = useBrowserSession(id, lowZoom || collapsed, browserStream, (url) => { openBrowserAt?.({ url, anchorNodeId: id }) })
  const searchEngine = toSearchEngine(useLiveSettings().browserSearchEngine)
  const [maximized, setMaximized] = useState(false)
  const [zoom, setZoom] = useState(ZOOM_DEFAULT)
  const expandedH = useRef(height ?? DEFAULT_H)
  const { state, send } = session
  const lastGo = useRef<string | undefined>(undefined)
  const device = resolveDevice(d.device)
  const surfaceSession = useDeviceSession(session, device)
  const consoleDrawer = useConsoleDrawer(session.hostRef, session.console, send, state?.lease, () => send({ t: 'nav', action: 'reload' }))

  useGoto({ want: d.url, state, send })

  // Simpan halaman terakhir ke data node: pulih dari sini saat sesi di-discard (PLAN b §4.7).
  // about:blank tidak boleh menimpa URL niat pengguna (isBlankUrl di shouldMirrorUrl).
  useEffect(() => {
    if (state && shouldMirrorUrl(state, d.url)) rf.updateNodeData(id, { url: state.url })
  }, [state, d.url, id, rf])

  // Catat halaman nyata yang sudah selesai dimuat ke daftar "Terbaru" halaman awal (kriteria sama dengan mirror URL).
  const recentUrl = state && !isBlankUrl(state.url) && !state.loading && !state.blocked ? state.url : undefined
  const recentTitle = state?.title ?? ''
  useEffect(() => { if (recentUrl) addRecent(recentUrl, recentTitle) }, [recentUrl, recentTitle])

  const ctx: BrowserSlotCtx = {
    id, state, error: session.error, target: lastGo.current ?? d.url,
    nav: (action, url) => {
      if (action === 'go' && url !== undefined) lastGo.current = url
      send({ t: 'nav', action, ...(url === undefined ? {} : { url }) })
    },
    takeover: () => send({ t: 'takeover' }),
    setShields: (on) => send({ t: 'shields', on }),
    device: d.device, setDevice: (dev) => { rf.updateNodeData(id, { device: dev ?? undefined }); send({ t: 'device', device: dev }) },
    zoom, stepZoom: (dir) => setZoom((z) => stepZoom(z, dir)),
    console: consoleDrawer.slot,
  }
  // d.url terisi = niat navigasi menunggu `useGoto`; jangan kedipkan halaman awal di antaranya. Diblokir: biarkan notice terlihat.
  const showStart = isBlankUrl(state?.url) && !d.url && !state?.blocked

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? DEFAULT_H; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div className={termNodeClass({ selected: !!selected, collapsed })} style={{ '--node-swatch': swatch } as CSSProperties}>
        <NodeChrome
          title={d.title || state?.title || DEFAULT_TITLE}
          icon="globe"
          description={state?.url ? hostOnly(state.url) : ''}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          onRefresh={() => ctx.nav('reload')}
          // Browser tidak punya pencarian di node; tombolnya tetap ada karena NodeToolbar milik bersama.
          searchOpen={false} onToggleSearch={() => undefined}
          maximized={maximized}
          onToggleMaximize={() => { rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized((m) => !m) }}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
          menuItems={menuItems}
        />
        <div className="node-body browser-node">
          {renderToolbar?.(ctx)}
          <BrowserDeviceHeader device={device} onRotate={() => d.device && ctx.setDevice({ ...d.device, landscape: !d.device.landscape })} />
          <div className="browser-body">
            <div className={device ? 'browser-zoom browser-zoom--device' : 'browser-zoom'} style={{ '--browser-zoom': zoom, ...deviceStyle(device) } as CSSProperties}>
              <BrowserSurface session={surfaceSession} />
            </div>
            {showStart && <BrowserStartPage onGo={(url) => ctx.nav('go', url)} searchEngine={searchEngine} />}
            {renderOverlay?.(ctx)}
          </div>
          {consoleDrawer.drawer}
        </div>
        {/* Handle kabel sama dengan AgentNode: kabel agent↔browser memberi agent itu izin mengemudikan
            browser ini (`resolveLinkedBrowser` server). Validasinya di `canLink`. */}
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in"  type="target" position={Position.Left}  className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(BrowserNode)
