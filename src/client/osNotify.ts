// OS notifications when an agent turn ends while the user is not looking at it. Browser port of
// Orca's delivery rules:
//  - suppress while the user is looking (window focused + surface active):
//    orca-src src/main/notifications/notification-delivery-service.ts:136-144
//  - muted workspaces get no banner or sound: src/renderer/src/attention/agent-attention-policy.ts:60-63
//  - unknown workspace fails OPEN ("Unknown presence must not silence"):
//    src/main/notifications/desktop-away-state.ts:16-18, hidden-workspace-notification-mute.ts:11-12
//  - burst collapse: src/shared/notification-burst-cooldown.ts (5s per key). Here one batch window
//    plus a fixed `tag` so the browser replaces, rather than stacks, the previous banner.
//  - click focuses the originating pane: src/main/ipc/native-notification-delivery.ts:107-117
//
// Fed by `./unread#noteStatus`, which sees EVERY status the socket delivers (including inactive
// workspaces), so no new server API is needed.
import type { AgentStatus } from '../shared/workspace'
import { AGENTS } from '../shared/workspace.agents'
import { fetchWorkspaces } from './api'
import { readNotifyPrefs } from './osNotify.prefs'

/** Batch window for bursts (several agents finishing together → one banner). */
export const COALESCE_MS = 1000
const TAG = 'webterm-attention'

const VERB: Record<Exclude<AgentStatus, 'working'>, string> = {
  done: 'finished',
  waiting: 'needs input',
  blocked: 'is blocked',
}

interface CanvasHooks {
  /** Fly the canvas to the node. */
  focus: (id: string) => void
  /** Is any part of the node on screen in the current canvas? */
  inView: (id: string) => boolean
}

let canvas: Partial<CanvasHooks> = {}
const lastStatus = new Map<string, AgentStatus>()
let pending = new Map<string, Exclude<AgentStatus, 'working'>>()
let timer: ReturnType<typeof setTimeout> | null = null
let promptShown = false

/** Each hook has its own owner: `focus` comes from App (`workspaceLifecycle#onFocus`, the only one
 *  that can switch workspace), `inView` from `./canvasViewport`. So installs merge per key, and the
 *  returned uninstaller removes only keys this install still owns. */
export function setNotifyCanvas(hooks: Partial<CanvasHooks>): () => void {
  canvas = { ...canvas, ...hooks }
  return () => {
    for (const k of Object.keys(hooks) as (keyof CanvasHooks)[]) {
      if (canvas[k] === hooks[k]) delete canvas[k]
    }
  }
}

function userIsLooking(id: string, watching: boolean): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false
  return watching || (canvas.inView?.(id) ?? false)
}

/**
 * Called for every status message. Notifies only on a TRANSITION into an ended turn: the server
 * replays the current status on every (re)attach (`src/server/sessions.ts` open → `send status`),
 * and a replay is not news.
 */
export function noteAttention(id: string, status: AgentStatus, watching: boolean): void {
  if (typeof window === 'undefined') return
  const prev = lastStatus.get(id)
  lastStatus.set(id, status)
  if (status === 'working' || prev === undefined || prev === status) return
  if (!readNotifyPrefs().enabled && !readNotifyPrefs().sound) return
  if (userIsLooking(id, watching)) return
  pending.set(id, status)
  timer ??= setTimeout(() => void flush(), COALESCE_MS)
}

function nodeLabel(n: { title?: string; agentId?: string }): string {
  return n.title || (n.agentId && (AGENTS as Record<string, { label: string }>)[n.agentId]?.label) || 'Agent'
}

async function flush(): Promise<void> {
  timer = null
  const batch = pending
  pending = new Map()
  const prefs = readNotifyPrefs()
  const owners = new Map<string, { ws: string; label: string }>()
  try {
    for (const ws of await fetchWorkspaces()) {
      for (const n of ws.nodes) if (batch.has(n.id)) owners.set(n.id, { ws: ws.name, label: nodeLabel(n) })
      if (prefs.muted.includes(ws.id)) for (const n of ws.nodes) batch.delete(n.id)
    }
  } catch (err) {
    // Fail open: a notification without names beats a silent one.
    console.warn('osNotify: workspace lookup failed; notifying without names', err)
  }
  const ids = [...batch.keys()]
  if (ids.length === 0) return
  if (prefs.sound) playChime()
  if (!prefs.enabled || typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    if (!promptShown) {
      promptShown = true
      void import('./osNotify.prompt').then((m) => m.showPermissionPrompt())
    }
    return
  }
  if (Notification.permission !== 'granted') return

  const first = ids[0]
  const who = owners.get(first)
  const title = ids.length === 1
    ? `${who?.label ?? 'Agent'} ${VERB[batch.get(first)!]}`
    : `${ids.length} agents need attention`
  const body = ids.length === 1
    ? (who ? `in ${who.ws}` : '')
    : ids.map((id) => `${owners.get(id)?.label ?? 'Agent'} ${VERB[batch.get(id)!]}`).join('\n')
  const n = new Notification(title, { body, tag: TAG })
  n.onclick = () => {
    window.focus()
    n.close()
    canvas.focus?.(first)
  }
}

let audio: AudioContext | null = null

/** Two-tone 180 ms chime via Web Audio — no asset to ship. Browsers keep the context suspended
 *  until the page has had a user gesture; then it plays even from a hidden tab. */
function playChime(): void {
  try {
    audio ??= new AudioContext()
    void audio.resume()
    const t = audio.currentTime
    const gain = audio.createGain()
    gain.connect(audio.destination)
    gain.gain.setValueAtTime(0.15, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    const osc = audio.createOscillator()
    osc.frequency.setValueAtTime(880, t)
    osc.frequency.setValueAtTime(1320, t + 0.08)
    osc.connect(gain)
    osc.start(t)
    osc.stop(t + 0.18)
  } catch (err) {
    console.warn('osNotify: could not play notification sound', err)
  }
}
