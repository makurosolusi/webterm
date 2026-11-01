// PTY palsu untuk test `sessions.ts` di vitest: tidak menyentuh `Bun.Terminal`, jadi seluruh jalur
// open/output/exit/close bisa diuji di node-env. Nama file sengaja `*.testutil.ts` (bukan
// `*.test.ts`) supaya tidak ikut ditemukan sebagai suite oleh runner mana pun.

import type { Pty } from './pty'

/** Merekam semua panggilan keluar (write/resize/kill) dan memancarkan data/exit saat diminta test. */
export class FakePty implements Pty {
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  killed = 0

  private dataCb: (data: string) => void = () => {}
  private exitCb: (code: number) => void = () => {}

  constructor(readonly pid: number = 1000) {}

  onData(cb: (data: string) => void): void { this.dataCb = cb }
  onExit(cb: (code: number) => void): void { this.exitCb = cb }

  /** Meniru PTY yang mengeluarkan output. */
  emitData(data: string): void { this.dataCb(data) }

  /** Meniru proses yang keluar sendiri. */
  emitExit(code: number): void { this.exitCb(code) }

  write(data: string): void { this.writes.push(data) }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }) }
  kill(): void { this.killed++ }
}
