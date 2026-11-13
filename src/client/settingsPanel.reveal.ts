// "Reveal setting" (VS Code): bring the element `[data-field="<id>"]` of the open Settings section into
// view, open any collapsed group around it, move focus to its control and flash it.
import type { SettingsFieldId } from './settings.link'

/** Class that flashes the revealed field (settings-sections.css; a still outline under reduced motion). */
export const REVEAL_CLASS = 'st-reveal'
export const REVEAL_MS = 1500
const POLL_MS = 50
const POLL_TRIES = 40 // sections that load async (capability cards, env values) render a moment later
const ENABLE_TRIES = 10 // a control may stay disabled for good (Central off): reveal it anyway after ~0.5 s
const CONTROL = 'input,select,textarea,[role="switch"],[role="combobox"],[role="radio"]'
/** A segmented choice's tab stop: the checked radio (SettingsSegmented gives only it tabindex 0). */
const CHECKED_RADIO = '[role="radio"][tabindex="0"]'
const FOCUSABLE = 'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'

/** Reveal `field` inside `root()` once it renders; returns the cleanup (stops waiting, ends the flash). */
export function revealSettingsField(root: () => HTMLElement | null, field: SettingsFieldId): () => void {
  let tries = 0
  let waited = 0
  let flash: number | undefined
  let flashed: HTMLElement | null = null
  const attempt = (): boolean => {
    const el = root()?.querySelector<HTMLElement>(`[data-field="${field}"]`)
    if (!el) return ++tries > POLL_TRIES
    const control = el.querySelector<HTMLElement>(CHECKED_RADIO) ?? el.querySelector<HTMLElement>(CONTROL) ?? el.querySelector<HTMLElement>(FOCUSABLE)
    // A control still disabled while its value loads (env, capabilities): give it a moment to enable.
    if (control?.matches(':disabled') && ++waited <= ENABLE_TRIES) return false
    for (let d = el.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true
    el.scrollIntoView?.({ block: 'center' })
    if (control && !control.matches(':disabled')) control.focus({ preventScroll: true })
    else {
      el.tabIndex = -1 // nothing to operate (a read-only block): focus the block so it is announced
      el.focus({ preventScroll: true })
    }
    el.classList.remove(REVEAL_CLASS)
    el.classList.add(REVEAL_CLASS)
    flashed = el
    flash = window.setTimeout(() => el.classList.remove(REVEAL_CLASS), REVEAL_MS)
    return true
  }
  const timer = attempt() ? undefined : window.setInterval(() => { if (attempt()) window.clearInterval(timer) }, POLL_MS)
  return () => {
    window.clearInterval(timer)
    window.clearTimeout(flash)
    flashed?.classList.remove(REVEAL_CLASS)
  }
}
