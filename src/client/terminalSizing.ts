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
