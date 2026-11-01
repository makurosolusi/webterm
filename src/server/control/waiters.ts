// Long-poll `wait` v1: polling in-process, bukan durable waiter. Dipisah supaya timeout dan
// kondisi "done" bisa dites tanpa menunggu jam dinding — `now` dan `sleep` di-inject.

import { WAIT_POLL_MS } from './controlTypes'

export interface WaitOptions {
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WaitOutcome<T> {
  done: boolean
  value: T
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Jangan pernah menahan proses hanya karena satu long-poll.
    timer.unref?.()
  })

/**
 * Poll `read` segera, lalu tiap `intervalMs` sampai `isDone` atau deadline.
 *
 * `isDone` menerima nilai poll SEBELUMNYA supaya kondisi seperti "output tidak berubah" bisa
 * diputuskan oleh pemanggil tanpa state tambahan di sini. Deadline memakai `now` yang di-inject;
 * tidur terakhir dipotong agar tidak melewati timeout.
 */
export async function pollUntil<T>(
  read: () => T,
  isDone: (current: T, previous: T | undefined) => boolean,
  options: WaitOptions
): Promise<WaitOutcome<T>> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const intervalMs = options.intervalMs ?? WAIT_POLL_MS
  const deadline = now() + Math.max(0, options.timeoutMs)
  let previous: T | undefined
  let current = read()
  for (;;) {
    if (isDone(current, previous)) return { done: true, value: current }
    const remaining = deadline - now()
    if (remaining <= 0) return { done: false, value: current }
    await sleep(Math.min(intervalMs, remaining))
    previous = current
    current = read()
  }
}
