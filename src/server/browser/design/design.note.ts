// Pure halves of Design Mode: where the screenshot crop goes, who receives the note, what it says.
import { BROWSER_KIND } from '../../../shared/browser.contract'
import type { Workspace } from '../../../shared/workspace'
import { linkedPeerIds } from '../../contextLinkRoute'
import { wrapUntrusted } from '../browserAgent.wrap'
import type { DesignCollect } from './design.overlay'

/** Clip for `Page.captureScreenshot` (document CSS px). */
export interface Clip { x: number; y: number; width: number; height: number; scale: number }

export const CROP_PAD = 8
/** Comment from the user: free text, bounded. */
export const DESIGN_COMMENT_MAX = 2000

/**
 * The union of the picked boxes, padded and clamped to the visible viewport, in DOCUMENT coordinates
 * (Puppeteer `ElementHandle.screenshot` does the same: viewport box + visual-viewport scroll offset).
 * null = nothing of the picks is on screen.
 */
export function cropBox(c: Pick<DesignCollect, 'picks' | 'viewport'>, pad = CROP_PAD): Clip | null {
  const vis = c.picks.map((p) => p.box).filter((b) => b.width > 0 && b.height > 0)
  if (!vis.length) return null
  const { width: vw, height: vh, scrollX, scrollY } = c.viewport
  const x0 = Math.max(0, Math.min(...vis.map((b) => b.x)) - pad)
  const y0 = Math.max(0, Math.min(...vis.map((b) => b.y)) - pad)
  const x1 = Math.min(vw, Math.max(...vis.map((b) => b.x + b.width)) + pad)
  const y1 = Math.min(vh, Math.max(...vis.map((b) => b.y + b.height)) + pad)
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: Math.round(x0 + scrollX), y: Math.round(y0 + scrollY), width: Math.round(x1 - x0), height: Math.round(y1 - y0), scale: 1 }
}

/** Agent nodes wired by a cable to browser node `browserId`: the recipients of its design notes. */
export function designTargets(ws: Workspace, browserId: string): string[] {
  const ids = linkedPeerIds(ws, browserId)
  return ws.nodes.filter((n) => ids.has(n.id) && n.kind !== BROWSER_KIND && !!n.agentId).map((n) => n.id)
}

// The note is pasted into a PTY: ESC/C0/C1 controls could end the bracketed paste early and type
// keystrokes. Only newline and tab survive.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')

/** The structured note for the agent. Page-derived text is wrapped as untrusted; the comment is the user's. */
export function composeDesignNote(c: DesignCollect, comment: string, shotPath: string | null, maxChars: number): string {
  const head = [
    '[webterm] Design Mode: the user picked element(s) in a browser node and asks for a change.',
    `User comment: ${clean(comment).trim() || '(none)'}`,
    `Page: ${clean(c.url)}`,
    shotPath ? `Cropped screenshot of the selection: ${shotPath} (read it to see the current look)` : 'Cropped screenshot: none (selection is off screen)',
    'Find the source of each element (use "source" when given) and make the change in the code.',
  ].join('\n')
  const render = (htmlMax: number) => c.picks.map((p, i) => [
    `## Element ${i + 1}: ${p.tag}`,
    `selector: ${p.selector}`,
    ...(p.source ? [`source: ${p.source}`] : []),
    ...(p.component ? [`component: ${p.component}`] : []),
    `box: x=${Math.round(p.box.x)} y=${Math.round(p.box.y)} w=${Math.round(p.box.width)} h=${Math.round(p.box.height)} (viewport px)`,
    `styles: ${Object.entries(p.styles).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
    `html: ${p.html.length > htmlMax ? `${p.html.slice(0, htmlMax)}…` : p.html}`,
  ].join('\n')).join('\n\n')
  // Shrink the per-element HTML until the note fits the outbox body cap.
  for (let htmlMax = 1500; ; htmlMax = Math.floor(htmlMax / 2)) {
    const note = `${head}\n${wrapUntrusted(clean(render(htmlMax)))}`
    if (note.length <= maxChars || htmlMax < 50) return note.slice(0, maxChars)
  }
}
