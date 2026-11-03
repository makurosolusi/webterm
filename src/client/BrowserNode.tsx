import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { NodeResizer, useReactFlow, useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NAV_ACTIONS, ZOOM_PAUSE_BELOW } from '../shared/browser.contract'
import type { BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'
import type { Comment } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import BrowserSurface from './browser.surface'
import { useBrowserSession } from './browser.useSession'
import { randomId } from './randomId'
import './browser.css'

const COLLAPSED_H = 40
const DEFAULT_H = 400
const DEFAULT_TITLE = 'Browser'

/** Konteks untuk slot UI (toolbar URL, chip lease; ditempel WS-11 dari komponen WS-09). */
export interface BrowserSlotCtx {
  id: string
  state?: BrowserState
  nav: (action: (typeof NAV_ACTIONS)[number], url?: string) => void
  takeover: () => void
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
  const d = data as { url?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []
  const lowZoom = useStore((s) => s.transform[2] < ZOOM_PAUSE_BELOW)
  const session = useBrowserSession(id, lowZoom || collapsed)
  const [maximized, setMaximized] = useState(false)
  const expandedH = useRef(height ?? DEFAULT_H)
  const { state, send } = session

  // Simpan halaman terakhir ke data node: pulih dari sini saat sesi di-discard (PLAN b §4.7).
  useEffect(() => {
    if (state?.url && !state.loading && !state.blocked && state.url !== d.url) rf.updateNodeData(id, { url: state.url })
  }, [state?.url, state?.loading, state?.blocked, d.url, id, rf])

  const ctx: BrowserSlotCtx = {
    id, state,
    nav: (action, url) => send({ t: 'nav', action, ...(url === undefined ? {} : { url }) }),
    takeover: () => send({ t: 'takeover' }),
  }

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? DEFAULT_H; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
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
        />
        <div className="node-body browser-node">
          {renderToolbar?.(ctx)}
          <div className="browser-body">
            <BrowserSurface session={session} />
            {renderOverlay?.(ctx)}
          </div>
        </div>
      </div>
    </>
  )
}

export default memo(BrowserNode)
