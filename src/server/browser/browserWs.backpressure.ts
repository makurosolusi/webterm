// Backpressure gateway /ws/browser: gerbang frame per (klien,node) + antrean serial input per node.
// Murni (tanpa I/O) supaya mudah diuji; `browserWs.viewers.ts` dan `browserWs.gateway.ts` memakainya.
import { FRAME_MAX_BUFFERED_BYTES, MAX_FRAMES_IN_FLIGHT } from '../../shared/browser.contract'

/** Batas antrean pesan per node; melewatinya, `mouse move` dibuang (event lain tetap antre agar up/down tak hilang). */
export const NODE_QUEUE_MAX = 256

export interface FrameGate {
  /** `send` = boleh kirim dan seq dicatat in-flight; `drop` = di luar jatah atau buffer socket penuh. */
  admit(seq: number, bufferedAmount: number): 'send' | 'drop'
  /** true bila seq memang in-flight (ack asing/basi = false, diabaikan). */
  ack(seq: number): boolean
  /** Lepas semua catatan in-flight dan kembalikan seq-nya. */
  clear(): number[]
  readonly inflight: number
}

/** Gerbang satu (klien,node): maks `maxInFlight` frame belum di-ack, dan buang bila `bufferedAmount` melewati batas. */
export function createFrameGate(maxInFlight = MAX_FRAMES_IN_FLIGHT, maxBuffered = FRAME_MAX_BUFFERED_BYTES): FrameGate {
  const inflight = new Set<number>()
  return {
    admit(seq, bufferedAmount) {
      if (inflight.size >= maxInFlight || bufferedAmount > maxBuffered) return 'drop'
      inflight.add(seq)
      return 'send'
    },
    ack: (seq) => inflight.delete(seq),
    clear() {
      const seqs = [...inflight]
      inflight.clear()
      return seqs
    },
    get inflight() { return inflight.size },
  }
}

/** Antrean serial: tugas dijalankan berurutan (urutan input manusia harus terjaga); galat tugas tidak menahan tugas berikut. */
export interface SerialQueue {
  /** Antre `task`; `droppable` + antrean penuh = tugas dibuang (false). */
  push(task: () => Promise<void>, droppable?: boolean): boolean
  readonly depth: number
}

export function createSerialQueue(max = NODE_QUEUE_MAX): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  let depth = 0
  return {
    push(task, droppable = false) {
      if (droppable && depth >= max) return false
      depth++
      // task menangani galatnya sendiri (gateway memetakan ke {t:'error'}); rantai hanya menjaga urutan.
      tail = tail.then(task).then(() => undefined, () => undefined).finally(() => { depth-- })
      return true
    },
    get depth() { return depth },
  }
}
