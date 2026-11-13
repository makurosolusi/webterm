// "Reveal setting" (VS Code): bring the element `[data-field="<id>"]` of the open Settings section into
// view, open any collapsed group around it, focus the field block (never its control) and flash it.
import type { SettingsFieldId } from './settings.link'

/** Class that flashes the revealed field (settings-sections.css; a still outline under reduced motion). */
export const REVEAL_CLASS = 'st-reveal'
export const REVEAL_MS = 1500
const POLL_MS = 50
const POLL_TRIES = 40 // sections that load async (capability cards, env values) render a moment later

/** Reveal `field` inside `root()` once it renders; returns the cleanup (stops waiting, ends the flash). */
export function revealSettingsField(root: () => HTMLElement | null, field: SettingsFieldId): () => void {
  let tries = 0
  let flash: number | undefined
  let flashed: HTMLElement | null = null
  const attempt = (): boolean => {
    const el = root()?.querySelector<HTMLElement>(`[data-field="${field}"]`)
    if (!el) return ++tries > POLL_TRIES
    for (let d = el.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true
    el.scrollIntoView?.({ block: 'center' })
    // Focus the block, not its control: a focused radio, select or stepper commits on arrow keys, and a
    // reveal must never leave the next key pressed to scroll rewriting a setting. Tab enters the control.
    el.tabIndex = -1
    el.focus({ preventScroll: true })
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
