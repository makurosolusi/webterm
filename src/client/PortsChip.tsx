// Status-bar chips for ports opened by this workspace's terminals ("localhost:5173 (brisk-otter)",
// VS Code Ports view / Orca WorkspacePortScanner). Click opens or reuses a Browser node beside the
// terminal that owns the port. The server scans (src/server/ports/); this only polls its cache.
import { useEffect, useMemo, useState } from 'react'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import type { DetectedPort } from '../server/ports/ports.service'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'
import { codicon } from './dockCodicon'

export const PORTS_POLL_MS = 5000
/** More chips than this collapse into the last one's tooltip. */
const MAX_CHIPS = 4

export async function fetchPorts(workspaceId: string, fetchFn: typeof fetch = fetch): Promise<DetectedPort[]> {
  const q = new URLSearchParams({ workspace: workspaceId }).toString()
  const res = await fetchFn(`/api/ports?${q}`)
  if (!res.ok) throw new Error(`Load detected ports: HTTP ${res.status}`)
  return ((await res.json()) as { ports: DetectedPort[] }).ports
}

/** `localhost:5173 (brisk-otter)`. */
export function portChipLabel(p: Pick<DetectedPort, 'url' | 'nodeLabel'>): string {
  return `${p.url.replace(/^https?:\/\//, '')} (${p.nodeLabel})`
}

/** Browser request for a chip: open beside the owning terminal. */
export function portChipRequest(p: Pick<DetectedPort, 'url' | 'nodeId'>): OpenBrowserReq {
  return { url: p.url, anchorNodeId: p.nodeId }
}

export function portStatusItems(ports: DetectedPort[], openBrowserAt?: (req: OpenBrowserReq) => OpenResult): VscodeStatusItem[] {
  return ports.slice(0, MAX_CHIPS).map((p) => {
    const label = portChipLabel(p)
    return {
      id: `port-${p.nodeId}-${p.port}`, label, icon: codicon('radio-tower'),
      tooltip: openBrowserAt ? `Open ${p.url} in a Browser node${p.processName ? ` (${p.processName})` : ''}` : `${label}: the Browser node is off`,
      ariaLabel: `Port ${p.port} from ${p.nodeLabel}`,
      onClick: openBrowserAt ? () => { openBrowserAt(portChipRequest(p)) } : undefined,
    }
  })
}

/** Chips for the active workspace; [] while there is none. */
export function usePortsStatusItems(workspaceId: string | null, openBrowserAt?: (req: OpenBrowserReq) => OpenResult): VscodeStatusItem[] {
  const [ports, setPorts] = useState<DetectedPort[]>([])
  useEffect(() => {
    setPorts([])
    if (!workspaceId) return
    let alive = true
    const load = () => fetchPorts(workspaceId).then((p) => { if (alive) setPorts(p) }, (e: unknown) => console.warn('ports:', e instanceof Error ? e.message : String(e)))
    void load()
    const t = setInterval(() => void load(), PORTS_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [workspaceId])
  return useMemo(() => portStatusItems(ports, openBrowserAt), [ports, openBrowserAt])
}
