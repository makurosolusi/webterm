/** Batas tunggu ukuran nyata sebelum `open` dikirim juga; node yang tak pernah berukuran tetap dapat sesi. */
export const OPEN_SIZE_FALLBACK_MS = 1500

export interface TermSize {
  cols: number
  rows: number
}

/** `resize` hanya dikirim bila grid beda dari yang terakhir terkirim (SIGWINCH tak gratis). */
export function sizeChanged(last: TermSize | null, next: TermSize): boolean {
  return last === null || last.cols !== next.cols || last.rows !== next.rows
}

/** `open` menunggu elemen berukuran; spawn di 80x24 untuk elemen 0x0 hanya dikoreksi paksa sesudahnya. */
export function canOpenSession(sized: boolean, fallbackElapsed: boolean): boolean {
  return sized || fallbackElapsed
}

/** Gabungkan panggilan beruntun jadi satu per frame (drag resize / zoom memicu observer berkali-kali). */
export function coalesceFrames(
  fn: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): { schedule(): void; cancel(): void } {
  let pending: number | null = null
  return {
    schedule() {
      if (pending !== null) return
      pending = raf(() => {
        pending = null
        fn()
      })
    },
    cancel() {
      if (pending !== null) caf(pending)
      pending = null
    },
  }
}

/**
 * Whether `el` currently intersects the viewport (false while display:none, in a hidden tab pane or
 * panned off-canvas). xterm pauses its renderer on the same signal and, while paused, defers the
 * renderer's resize; a `term.resize` in that window makes Viewport._sync clamp the scrollbar against
 * the STALE canvas height and drag the buffer to the top. Callers must therefore not resize while
 * `visible` is false. xterm's observer is created first (in `term.open`), and observers are notified in
 * creation order, so `onShown` always runs after xterm has un-paused. Starts `true` (as does xterm)
 * and stays so without IntersectionObserver.
 */
export function watchVisible(
  el: Element,
  onShown: () => void,
  IO: typeof IntersectionObserver | undefined = globalThis.IntersectionObserver,
): { readonly visible: boolean; stop(): void } {
  let visible = true
  const io = IO
    ? new IO((entries) => {
        const was = visible
        visible = entries[entries.length - 1].isIntersecting
        if (visible && !was) onShown()
      })
    : null
  io?.observe(el)
  return { get visible() { return visible }, stop: () => io?.disconnect() }
}
