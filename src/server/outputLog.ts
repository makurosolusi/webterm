// Satu tanggung jawab: buffer potongan output sebuah terminal dengan batas BYTE dan nomor urut
// monoton, supaya klien bisa menyambung ulang dan tahu kapan ia kehilangan potongan.
//
// Kenapa byte, bukan karakter: batas memori yang sebenarnya adalah byte UTF-8, dan satu emoji atau
// huruf CJK memakan 3-4 byte. Menghitung `data.length` (UTF-16 code unit) membuat cap meleset sampai
// 4x untuk teks non-ASCII. Karena itu setiap potongan menyimpan byte-nya sendiri saat `append`.
//
// Kenapa eviction membuang POTONGAN UTUH, bukan memotong ekor/awal potongan: potongan adalah
// rangkaian escape ANSI xterm. Memotong di tengah urutan escape menghasilkan byte sampah yang
// merusak layar klien. Potongan terbaru SELALU dipertahankan walau ia sendirian melewati cap —
// membuangnya berarti klien tidak menerima apa pun sama sekali.
//
// Modul ini murni: tidak tahu sesi, socket, atau DB. Pemanggil yang memegang `OutputLog` per sesi.

/** Satu potongan output beserta nomor urut dan ukuran byte UTF-8-nya. */
export interface OutputChunk {
  /** Monoton naik mulai dari 1. */
  seq: number
  data: string
}

const encoder = new TextEncoder()

/** Panjang byte UTF-8 sebuah string. */
function byteLength(data: string): number {
  return encoder.encode(data).length
}

export class OutputLog {
  /** Potongan yang masih disimpan, urut dari terlama ke terbaru. */
  private chunks: OutputChunk[] = []
  /** Ukuran byte seluruh potongan yang disimpan. */
  private totalBytes = 0
  /** Nomor urut berikutnya. Naik selamanya, tidak pernah mundur walau potongan dibuang. */
  private nextSeq = 1

  /**
   * Menambahkan satu potongan output dan mengembalikan nomor urutnya.
   *
   * String kosong tidak disimpan (tidak ada byte, tidak ada arti bagi klien) dan mengembalikan
   * nomor urut terakhir yang pernah diberikan — 0 bila belum ada apa pun.
   */
  append(data: string, capBytes: number): number {
    if (data === '') return this.lastSeq()
    const chunk: OutputChunk = { seq: this.nextSeq++, data }
    this.chunks.push(chunk)
    this.totalBytes += byteLength(data)
    this.evict(capBytes)
    return chunk.seq
  }

  /**
   * Potongan dengan `seq > givenSeq`, urut lama → baru.
   *
   * Gap TIDAK dideteksi di sini; pemanggil membandingkan `givenSeq + 1` dengan `floorSeq()`.
   * `since(last)` yang mengembalikan array kosong berarti "tidak ada yang baru", bukan "tidak ada
   * data" — bedakan lewat `floorSeq`.
   */
  since(givenSeq: number): OutputChunk[] {
    // chunks urut seq naik, jadi binary search batas bawah cukup untuk log panjang.
    let lo = 0
    let hi = this.chunks.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.chunks[mid].seq <= givenSeq) lo = mid + 1
      else hi = mid
    }
    return this.chunks.slice(lo)
  }

  /** Nomor urut terakhir yang pernah diberikan; 0 bila log belum pernah menerima data. */
  lastSeq(): number {
    return this.nextSeq - 1
  }

  /** Nomor urut terendah yang masih disimpan. Sama dengan `lastSeq() + 1` bila log kosong. */
  floorSeq(): number {
    return this.chunks.length > 0 ? this.chunks[0].seq : this.nextSeq
  }

  /** Semua potongan yang masih disimpan, digabung apa adanya. */
  text(): string {
    let out = ''
    for (const chunk of this.chunks) out += chunk.data
    return out
  }

  /** Ukuran byte UTF-8 seluruh potongan yang masih disimpan. */
  bytes(): number {
    return this.totalBytes
  }

  /** Membuang potongan terlama sampai muat, menyisakan minimal potongan terbaru. */
  private evict(capBytes: number): void {
    // Hitung dulu berapa potongan terdepan yang harus pergi, baru potong sekali: `shift()` di dalam
    // loop membuat eviction O(n^2) justru saat log paling besar.
    let drop = 0
    while (this.chunks.length - drop > 1 && this.totalBytes > capBytes) {
      this.totalBytes -= byteLength(this.chunks[drop].data)
      drop++
    }
    if (drop > 0) this.chunks = this.chunks.slice(drop)
  }
}
