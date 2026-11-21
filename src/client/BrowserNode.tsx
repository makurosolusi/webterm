import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import type { NodeProps } from '@xyflow/react'
import { NAV_ACTIONS, ZOOM_PAUSE_BELOW } from '../shared/browser.contract'
import type { BrowserState } from '../shared/browser.contract'
import { browserHeaderLabels } from './browser.header'
import type { BrowserErr } from './browser.status'
import type { Comment } from '../shared/workspace'
import type { DownloadItem } from '../shared/browser.downloads'
import NodeChrome, { termNodeClass } from './NodeChrome'
import BrowserSurface from './browser.surface'
import { useBrowserSession } from './browser.useSession'
import { browserStream } from './browser.stream'
import BrowserProfileChip from './BrowserProfileChip'
import BrowserAudioButton, { audioOffered } from './browser/BrowserAudioButton'
import { useBrowserAudio } from './browser/browserAudio.use'
import { useBrowserStatus } from './browser.feature'
import { isBlankUrl, shouldMirrorUrl, useGoto } from './browser.useGoto'
import BrowserStartPage from './BrowserStartPage'
import { addRecent } from './browser.recent'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, stepZoom } from './browser.zoom'
import { browserChord } from './browser.keys'
import type { BrowserChord } from './browser.keys'
import { isMacPlatform } from './terminalKeys'
import { randomId } from './randomId'
import { useLiveSettings } from './useSettings'
import { toSearchEngine } from '../shared/browser.omnibox'
import { resolveDevice } from '../shared/browser.devices'
import type { DeviceChoice } from '../shared/browser.devices'
import BrowserDeviceHeader from './BrowserDeviceHeader'
import { deviceStyle, useDeviceSession } from './browser.device'
import { useConsoleDrawer } from './BrowserConsole'
import type { ConsoleSlot } from './BrowserConsole'
import { useNodeHost } from './tabLayout.context'
import { BrowserTabStrip } from './browserTabs/BrowserTabStrip'
import { BrowserTabPanel, showsNewTabPage } from './browserTabs/BrowserTabPanel'
import { BrowserNodeDown, DOWN_TEXT } from './browserTabs/BrowserNodeDown'
import { COLLAPSED_H, DEFAULT_H, hideBrowserNode, hideCandidates, rememberHeight, takeHeight } from './browser.hide'
import { browserTabDomId } from './browserTabs/BrowserTabItem'
import { useBrowserTabs } from './browserTabs/useBrowserTabs'
import type { TabMsg } from './browserTabs/useBrowserTabs'
import { useBrowserContextMenu, type ContextMenuMsg } from './browserContextMenu/useBrowserContextMenu'
import { useBrowserTabShortcuts } from './browserTabs/useBrowserTabShortcuts'
import { BrowserPaneTree } from './browserSplit/BrowserPaneTree'
import { BrowserSplitMenu } from './browserSplit/BrowserSplitMenu'
import { BrowserSyncToggle } from './browserSplit/BrowserSyncToggle'
import { useBrowserSplit } from './browserSplit/useBrowserSplit'
import { useBrowserSplitShortcuts } from './browserSplit/useBrowserSplitShortcuts'
import { zoneBox } from './browserSplit/browserSplit.drop'
import type { DropHint } from './browserSplit/browserSplit.drop'
import './browserUi.css'
import './browser.css'
import './browser.driven.css'

const DEFAULT_TITLE = 'Browser'
/** Accumulated Ctrl+wheel delta (px) per zoom step: one mouse notch (~100) is a step, a trackpad pinch needs a deliberate spread. */
const WHEEL_ZOOM_PX = 50

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
  /** "I'm done" on a human-check banner: the server stops flagging the page and agents continue. */
  challengeDone: () => void
  /** Page zoom (1 = 100%) and its step; client-side (browser.zoom.ts), saved in node data `zoom`. */
  zoom: number
  stepZoom: (dir: -1 | 1) => void
  /** Back to 100% (⌘0, toolbar zoom pill). */
  resetZoom: () => void
  /** Nyalakan/matikan Shields untuk situs halaman ini. */
  setShields: (on: boolean) => void
  /** Device mode saved on the node (absent = Responsive) and its setter (null = Responsive). */
  device?: DeviceChoice
  setDevice: (device: DeviceChoice | null) => void
  /** Console drawer toggle + error badge count. */
  console?: ConsoleSlot
  /** Downloads of this node (shown by the toolbar's Downloads button). */
  downloads: DownloadItem[]
}

export interface BrowserNodeProps extends NodeProps {
  /** Dirender di atas permukaan (mis. toolbar URL). */
  renderToolbar?: (ctx: BrowserSlotCtx) => ReactNode
  /** Dirender menimpa permukaan (mis. chip "agent mengemudi"). */
  renderOverlay?: (ctx: BrowserSlotCtx) => ReactNode
}

/**
 * Node browser sungguhan: canvas yang menggambar screencast Chromium server-side dan meneruskan
 * input manusia. Berhenti menerima frame saat collapse atau zoom canvas < `ZOOM_PAUSE_BELOW`
 * (frame terakhir tetap terlihat). Tidak didaftarkan di `nodeTypes` di sini (WS-11).
 */
function BrowserNode({ id, data, selected, height, renderToolbar, renderOverlay }: BrowserNodeProps) {
  const d = data as { url?: string; color?: string; name?: string; title?: string; collapsed?: boolean; profileId?: string; comments?: Comment[]; device?: DeviceChoice; zoom?: number; audio?: boolean }
  const rf = useReactFlow()
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []
  const { inTab, visible, maximized } = useNodeHost()
  // Canvas zoom is irrelevant in a tab pane or maximized (1:1 either way); a hidden tab detaches the stream.
  const lowZoom = useStore((s) => !inTab && !maximized && s.transform[2] < ZOOM_PAUSE_BELOW)
  // Popups are tabs of this node now (server side); the tab messages feed `useBrowserTabs` below.
  const tabMsg = useRef<(m: TabMsg | ContextMenuMsg) => void>(undefined)
  const sessionPaused = lowZoom || (collapsed && !inTab) || !visible
  const session = useBrowserSession(id, sessionPaused, browserStream, (m) => tabMsg.current?.(m), d.profileId)
  const showAudio = audioOffered(useBrowserStatus())
  const audio = useBrowserAudio(id, browserStream, session.audioSink, { paused: sessionPaused, offered: showAudio, muted: d.audio === false, persist: (muted) => rf.updateNodeData(id, { audio: muted ? false : undefined }) })
  const searchEngine = toSearchEngine(useLiveSettings().browserSearchEngine)
  const [zoom, setZoomState] = useState(() => typeof d.zoom === 'number' ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, d.zoom)) : ZOOM_DEFAULT)
  // Ref, not state, as the step base: a pinch fires many wheel events before React re-renders.
  const zoomRef = useRef(zoom)
  const setZoom = (z: number) => {
    zoomRef.current = z
    setZoomState(z)
    rf.updateNodeData(id, { zoom: z === ZOOM_DEFAULT ? undefined : z })
  }
  const bodyRef = useRef<HTMLDivElement>(null)
  const expandedH = useRef(height ?? DEFAULT_H)
  const { state, send } = session
  const tabs = useBrowserTabs(id, state, send)
  const pageMenu = useBrowserContextMenu({ bodyRef, send, nav: (action) => send({ t: 'nav', action }), canBack: !!state?.canBack, canForward: !!state?.canForward, notify: tabs.notify })
  tabMsg.current = (m) => { if (!pageMenu.onMsg(m)) tabs.onMsg(m as TabMsg) } // right click on the page = webterm's own menu (never Chromium's)
  useBrowserTabShortcuts({ containerRef: bodyRef, state: tabs.view, onAction: tabs.act, onNotice: tabs.notify })
  const split = useBrowserSplit(tabs, session, send, session.hostRef)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  useBrowserSplitShortcuts({ containerRef: bodyRef, onSplitRight: () => { void split.split('right') }, onFocus: split.moveFocus })
  const layout = tabs.view.layout
  const focusId = split.focusId
  const room = focusId ? split.canSplitAt(focusId, 'right') : undefined
  const splitMenu = tabs.standIn || !focusId ? undefined : { run: (tabId: string, edge: 'right' | 'bottom') => { void split.dropTab(tabId, focusId, edge) }, blocked: room && !room.ok ? room.reason : undefined }
  const panelId = `bt-panel-${id}`
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

  // The MAX_LIVE gate refused this node: it has no page. Say so (plate) and never swallow input silently (nav below).
  const down = session.error?.code === 'max_live' && state?.live !== 'live'
  const ctx: BrowserSlotCtx = {
    id, state, error: session.error, target: lastGo.current ?? d.url,
    nav: (action, url) => {
      if (down) { tabs.notify(DOWN_TEXT.blockedNav, 'warning'); return }
      if (action === 'go' && url !== undefined) lastGo.current = url
      send({ t: 'nav', action, ...(url === undefined ? {} : { url }) })
    },
    takeover: () => send({ t: 'takeover' }),
    challengeDone: () => send({ t: 'challengeDone' }),
    setShields: (on) => send({ t: 'shields', on }),
    device: d.device, setDevice: (dev) => { rf.updateNodeData(id, { device: dev ?? undefined }); send({ t: 'device', device: dev }) },
    zoom, stepZoom: (dir) => setZoom(stepZoom(zoomRef.current, dir)), resetZoom: () => setZoom(ZOOM_DEFAULT),
    console: consoleDrawer.slot, downloads: session.downloads,
  }
  // d.url terisi = niat navigasi menunggu `useGoto`; jangan kedipkan halaman awal di antaranya. Diblokir: biarkan notice terlihat.
  // Browser-level shortcuts (browser.keys.ts): handled here, never forwarded to the page.
  const runChord = (a: BrowserChord): boolean => {
    switch (a) {
      case 'stop': if (!state?.loading) return false; ctx.nav('stop'); return true // idle: Esc belongs to the page
      case 'reload': case 'hardReload': ctx.nav('reload'); return true // TODO(browser): hardReload = cache-bypassing reload once the nav contract has one
      case 'back': ctx.nav('back'); return true
      case 'forward': ctx.nav('forward'); return true
      case 'zoomIn': ctx.stepZoom(1); return true
      case 'zoomOut': ctx.stepZoom(-1); return true
      case 'zoomReset': ctx.resetZoom(); return true
      case 'focusUrl': {
        const input = bodyRef.current?.querySelector<HTMLInputElement>('[data-browser-omnibox]')
        input?.focus()
        input?.select()
        return true
      }
    }
  }
  const runChordRef = useRef(runChord)
  runChordRef.current = runChord
  const stepZoomRef = useRef(ctx.stepZoom)
  stepZoomRef.current = ctx.stepZoom
  // Capture phase on the node body: runs before the surface's React onKeyDown/wheel, which would forward to the page.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    let wheelAcc = 0
    const onKey = (e: KeyboardEvent) => {
      const a = browserChord(e, isMacPlatform())
      if (!a || !runChordRef.current(a)) return
      e.preventDefault()
      e.stopPropagation()
    }
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return // Ctrl+wheel = mouse zoom and trackpad pinch
      e.preventDefault()
      e.stopPropagation()
      wheelAcc += e.deltaY
      if (Math.abs(wheelAcc) < WHEEL_ZOOM_PX) return
      stepZoomRef.current(wheelAcc < 0 ? 1 : -1)
      wheelAcc = 0
    }
    el.addEventListener('keydown', onKey, true)
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => { el.removeEventListener('keydown', onKey, true); el.removeEventListener('wheel', onWheel, { capture: true }) }
  }, [])
  const driven = state?.lease === 'agent'
  const header = browserHeaderLabels({ userTitle: d.title, pageTitle: state?.title, url: state?.url, fallback: DEFAULT_TITLE })
  const showStart = !down && isBlankUrl(state?.url) && !d.url && !state?.blocked && !showsNewTabPage(tabs.view, tabs.active, tabs.standIn)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? DEFAULT_H; rememberHeight(id, expandedH.current); rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: takeHeight(id) ?? expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div className={termNodeClass({ selected: !!selected, collapsed }) + (driven ? ' browser-node--driven' : '')} style={{ '--node-swatch': swatch } as CSSProperties}>
        <NodeChrome
          title={header.title} titleHint={header.hint} name={d.name}
          icon="globe"
          description={header.description}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          // Profile chip: in the canvas header and, in tab mode, among the tab's actions (both render `extraHeader`).
          extraHeader={<>{showAudio && <BrowserAudioButton audio={audio} active={state?.audioActive} />}<BrowserProfileChip nodeId={id} profileId={d.profileId} /></>}
          comments={comments}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          // Node actions only: reload lives in the toolbar and there is no find yet, so no Refresh/Search rows here;
          // page actions (zoom, cookies, …) are in the toolbar's ⋮ menu, the node's one browser menu.
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div ref={bodyRef} className="node-body browser-node">
          <BrowserTabStrip
            state={tabs.view} onAction={tabs.act} onNotice={tabs.notify} panelId={panelId}
            agentActive={driven}
            trailing={tabs.standIn ? undefined : <><BrowserSplitMenu controls={split} /><BrowserSyncToggle nodeId={id} sync={session.sync} panes={split.shown.length} /></>}
            split={splitMenu}
            onPaneHover={setDropHint} onPaneDrop={(tabId, hit) => { void split.dropTab(tabId, hit.paneTabId, hit.zone) }}
          />
          {renderToolbar?.(ctx)}
          {!layout && <BrowserDeviceHeader device={device} onRotate={() => d.device && ctx.setDevice({ ...d.device, landscape: !d.device.landscape })} />}
          <div
            className="browser-body nodrag nopan" role="tabpanel" id={panelId} data-pane-tab={layout ? undefined : tabs.active?.tabId}
            aria-labelledby={tabs.active ? browserTabDomId(tabs.active.tabId) : undefined} aria-label={tabs.active ? undefined : 'New tab'}
          >
            <div className={device && !layout ? 'browser-zoom browser-zoom--device' : 'browser-zoom'} style={{ '--browser-zoom': zoom, ...(layout ? {} : deviceStyle(device)) } as CSSProperties}>
              <BrowserSurface
                session={layout ? session : surfaceSession}
                panes={layout ? <BrowserPaneTree layout={layout} state={tabs.view} session={session} controls={split} dropHint={dropHint} /> : undefined}
              />
            </div>
            {!layout && <BrowserTabPanel view={tabs.view} active={tabs.active} standIn={tabs.standIn} act={tabs.act} go={(url) => ctx.nav('go', url)} />}
            {!layout && dropHint && dropHint.paneTabId === tabs.active?.tabId && <div className="bp-drop" aria-hidden="true" style={zoneBox(dropHint.zone)} data-zone={dropHint.zone} />}
            {showStart && !layout && <BrowserStartPage onGo={(url) => ctx.nav('go', url)} searchEngine={searchEngine} />}
            {renderOverlay?.(ctx)}
            {pageMenu.menu}
            {down && <BrowserNodeDown others={hideCandidates(rf.getNodes(), id)} onHide={(other) => hideBrowserNode(rf, other)} onRetry={session.retry} answer={session.error ?? state} />}
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
