// Peta input manusia (kontrak WS) -> perintah `Input.dispatch*` CDP. Murni, tanpa I/O.
import { DSF_MAX, JPEG_QUALITY_DEFAULT, MOD, SCREENCAST_MAX_DIM } from '../../shared/browser.contract'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { CDP } from './cdp.client'

export interface CdpCommand { method: string; params: Record<string, unknown> }

const MOUSE_TYPE = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' } as const
const TOUCH_TYPE = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' } as const
const SHORTCUT_MODS = MOD.Ctrl | MOD.Meta

/** Perintah CDP untuk satu input; `modifiers` memakai bitmask yang sama dengan CDP (Alt=1 Ctrl=2 Meta=4 Shift=8). */
export function toCdpCommands(ev: BrowserInputEvent): CdpCommand[] {
  switch (ev.t) {
    case 'mouse': {
      // A move with a button held must name it, or Chromium drops drag selection (also for clients that send 'none').
      const button = ev.type === 'move' && ev.button === 'none' ? (ev.buttons & 1 ? 'left' : ev.buttons & 4 ? 'middle' : 'none') : ev.button
      return [{
        method: CDP.mouse,
        params: {
          type: MOUSE_TYPE[ev.type], x: ev.x, y: ev.y, button, buttons: ev.buttons,
          clickCount: ev.clickCount, modifiers: ev.mods, deltaX: ev.dx, deltaY: ev.dy, pointerType: 'mouse',
        },
      }]
    }
    case 'key': {
      const base = { key: ev.key, code: ev.code, modifiers: ev.mods, windowsVirtualKeyCode: ev.vk, nativeVirtualKeyCode: ev.vk }
      if (ev.type === 'up') return [{ method: CDP.key, params: { type: 'keyUp', ...base } }]
      const cmds: CdpCommand[] = [{ method: CDP.key, params: { type: 'rawKeyDown', ...base } }]
      // Shortcut (Ctrl/Cmd+huruf) tidak menghasilkan karakter.
      if (ev.text && !(ev.mods & SHORTCUT_MODS)) {
        cmds.push({ method: CDP.key, params: { type: 'char', text: ev.text, unmodifiedText: ev.text, ...base } })
      }
      return cmds
    }
    case 'text':
      return [{ method: CDP.insertText, params: { text: ev.text } }]
    case 'ime':
      return [{ method: CDP.ime, params: { text: ev.text, selectionStart: ev.start, selectionEnd: ev.end } }]
    case 'touch': {
      // ponytail: end/cancel mengirim daftar kosong (benar untuk satu jari); multi-touch parsial perlu sisa titik.
      const live = ev.type === 'end' || ev.type === 'cancel' ? [] : ev.points
      return [{ method: CDP.touch, params: { type: TOUCH_TYPE[ev.type], touchPoints: live.map((p) => ({ x: p.x, y: p.y, id: p.id, force: p.force ?? 1 })) } }]
    }
  }
}

/** `deviceScaleFactor` dijepit ke (0, DSF_MAX]. */
export function clampDpr(dpr: number): number {
  return Math.min(Math.max(dpr, Number.MIN_VALUE), DSF_MAX)
}

/** Parameter `Emulation.setDeviceMetricsOverride` (viewport CSS px bulat, DSF dijepit). */
export function metricsParams(w: number, h: number, dpr: number): Record<string, unknown> {
  return { width: Math.round(w), height: Math.round(h), deviceScaleFactor: clampDpr(dpr), mobile: false }
}

/**
 * Parameter `Page.startScreencast`: batas frame = viewport x dpr, dijepit SCREENCAST_MAX_DIM (DevTools
 * ScreencastView.ts:560-571). Tanpa batas, jendela headful di layar Retina menangkap 2x fisik walau dpr 1.
 */
export function screencastParams(vp: { w: number; h: number; dpr: number }): Record<string, unknown> {
  const dpr = clampDpr(vp.dpr)
  return {
    format: 'jpeg', quality: JPEG_QUALITY_DEFAULT,
    maxWidth: Math.min(SCREENCAST_MAX_DIM, Math.round(vp.w * dpr)), maxHeight: Math.min(SCREENCAST_MAX_DIM, Math.round(vp.h * dpr)),
  }
}
