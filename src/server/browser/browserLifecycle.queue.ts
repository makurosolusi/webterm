// Antrean node browser yang hidup (live atau paused) untuk batas MAX_LIVE. Murni: tanpa host, timer, atau jam.

export interface LiveEntry {
  visible: boolean
  /** Waktu (ms, jam injeksi) node mulai tersembunyi; null saat terlihat. */
  hiddenSince: number | null
}

export class LiveQueue {
  private readonly entries = new Map<string, LiveEntry>()

  /** Jumlah node hidup (terlihat + paused). */
  get size(): number { return this.entries.size }

  /** Entri node, atau undefined bila tidak terlacak. */
  get(nodeId: string): LiveEntry | undefined { return this.entries.get(nodeId) }

  /** Daftarkan node sebagai terlihat (idempotent; menandai terlihat bila sudah ada). */
  add(nodeId: string): void { this.entries.set(nodeId, { visible: true, hiddenSince: null }) }

  /** Ubah visibilitas; `hiddenSince` asli dipertahankan bila sudah tersembunyi. Mengembalikan entri, undefined bila tak terlacak. */
  setVisible(nodeId: string, visible: boolean, now: number): LiveEntry | undefined {
    const e = this.entries.get(nodeId)
    if (!e) return undefined
    e.hiddenSince = visible ? null : (e.hiddenSince ?? now)
    e.visible = visible
    return e
  }

  /** Hapus node dari antrean. */
  remove(nodeId: string): void { this.entries.delete(nodeId) }

  /** Semua id terlacak. */
  ids(): string[] { return [...this.entries.keys()] }

  /** Node tersembunyi tertua (hiddenSince terkecil) yang boleh dikorbankan; undefined bila tak ada. */
  oldestHidden(canEvict: (nodeId: string) => boolean): string | undefined {
    let best: string | undefined
    let bestSince = Infinity
    for (const [id, e] of this.entries) {
      if (e.hiddenSince === null || e.hiddenSince >= bestSince || !canEvict(id)) continue
      best = id
      bestSince = e.hiddenSince
    }
    return best
  }
}
