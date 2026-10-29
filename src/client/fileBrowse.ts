/**
 * Keputusan yang diambil sebuah node file-manager, dijaga MURNI supaya bisa ditekan di test alih-
 * alih diklik di aplikasi: direktori "naik" yang mana, apa yang ditampilkan breadcrumb, apa yang
 * dicocokkan filter, dan apa yang terjadi saat sesuatu dibuka. Vitest webterm berjalan di node-env
 * tanpa DOM, jadi semua logika yang perlu dites memang harus duduk di sini, bukan di `.tsx`.
 *
 * Porting dari nodeterm `src/renderer/lib/filesNode.ts` + `src/renderer/lib/explorerCreate.ts`
 * (path helper) + `src/renderer/lib/openTarget.ts` (ekstensi) + `isMediaFile` dari
 * `src/renderer/state/workspace.ts`. Digabung jadi satu modul karena webterm tidak punya Explorer
 * drawer maupun quick-open yang ikut memakai helper-helper itu.
 *
 * TIDAK DIPORT: `downloadMenuEntries` (webterm tidak punya rute download scp/HTTP) dan
 * `displacedFilesPatch` (tidak ada binding worktree yang bisa menggeser sebuah node).
 *
 * Path selalu absolut dipisah `/`. Celah Windows (`C:\x\y` terbaca satu segmen) diwarisi apa
 * adanya dari nodeterm; server webterm berjalan di POSIX.
 */

/** Satu entry direktori. Kembaran sisi server ada di `src/server/fsOps.ts` — dua deklarasi, satu
 *  per sisi batas HTTP, karena `src/shared` final dan client tidak boleh menarik `node:fs`. */
export interface DirEntry {
  name: string
  dir: boolean
  ignored?: boolean
}

/** Nama sebuah direktori — segmen terakhirnya, atau '/' di root. */
export function folderTitle(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '/'
}

export function parentDir(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** Gabungkan direktori dan nama entry. Slash di ujung direktori diserap, jadi root ('/') tidak
 *  menghasilkan separator ganda. */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** Direktori yang dituju sebuah "New file…": dir yang diklik, atau induk dari file yang diklik. */
export function createTargetDir(path: string, isDir: boolean): string {
  return isDir ? path : parentDir(path)
}

/**
 * Tempelkan nama yang diketik pengguna ke sebuah base dir. Nama relatif multi-segmen (`a/b.ts`)
 * diizinkan; direktori perantaranya tugas pemanggil (lihat `ancestorDirs`). `null` untuk apa pun
 * yang tidak masuk akal atau tidak aman: kosong, absolut, traversal `..`, berakhir separator.
 *
 * Guard `..` memecah pada KEDUA separator: `..\x` adalah satu segmen yang bukan kosong dan bukan
 * `..`, jadi ia lolos dan baru keluar dari `baseDir` saat ada filesystem yang mengurai `\`. Path
 * tetap DIBANGUN dengan `/`, dan cek segmen kosong tetap memecah pada `/` saja — di POSIX
 * backslash adalah teks nama file yang sah, jadi menolak `a\b` berarti guard ini salah soal
 * filesystem yang ditulisinya. Guard pada dua dialek, bangun pada satu.
 */
export function newEntryPath(baseDir: string, name: string): string | null {
  const n = name.trim()
  if (!n) return null
  if (n.startsWith('/') || n.startsWith('\\') || /^[A-Za-z]:/.test(n)) return null
  if (n.endsWith('/') || n.endsWith('\\')) return null
  if (n.split(/[\\/]/).some((seg) => seg === '..')) return null
  if (n.split('/').some((seg) => !seg)) return null
  return `${baseDir.replace(/\/+$/, '')}/${n}`
}

/** Path absolut direktori perantara yang dilewati nama bersarang (paling dangkal dulu). */
export function ancestorDirs(baseDir: string, name: string): string[] {
  const segs = name.trim().split('/').slice(0, -1)
  const out: string[] = []
  let acc = baseDir.replace(/\/+$/, '')
  for (const s of segs) {
    acc = `${acc}/${s}`
    out.push(acc)
  }
  return out
}

/** Satu breadcrumb: apa yang ditampilkan, dan ke mana kliknya pergi. */
export interface Crumb {
  name: string
  path: string
}

/**
 * Header node lebarnya beberapa ratus piksel dan path project nyata tidak. `max` adalah jumlah
 * segmen TERAKHIR yang dipertahankan; yang lebih dalam diringkas jadi satu crumb depan yang TETAP
 * bisa dinavigasi (ke direktori tersembunyi terdalam) — breadcrumb yang tidak bisa diklik hanyalah
 * teks. Root selalu terjangkau sebagai crumb pertama, alasannya sama.
 */
export function breadcrumbs(path: string, max = 3): Crumb[] {
  const segs = path.split('/').filter(Boolean)
  const all: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    all.push({ name: s, path: acc })
  }
  if (all.length <= max + 1) return all
  const hidden = all.slice(1, all.length - max)
  const ellipsis: Crumb = { name: '…', path: hidden[hidden.length - 1].path }
  return [all[0], ellipsis, ...all.slice(all.length - max)]
}

export type EmptyListingVerdict = 'empty' | 'missing' | 'unreachable' | 'unknown'

/**
 * Apa arti sebenarnya sebuah listing KOSONG.
 *
 * `fsOps.listDir` fail-open secara kontrak (`catch { return [] }`), jadi direktori yang DIHAPUS
 * datang tidak terbedakan dari direktori yang memang kosong. Kita juga tidak bertanya ke
 * `fs.exists`: ia berbasis `stat`, jadi ia menjawab TRUE untuk direktori yang bisa di-stat tapi
 * tidak bisa di-`readdir`. Jadi yang ditanya adalah listing INDUK — satu `fs.list` kedua.
 *
 * Empat jawaban, dan dua terakhir justru intinya:
 *  - `missing` — induk mendaftar entry nyata dan milik kita tidak ada di antaranya. HANYA ini yang
 *    berhak memunculkan state error.
 *  - `empty` — induk mendaftar kita, jadi direktorinya ada dan memang tidak berisi apa-apa. Root
 *    juga ke sini: ia tidak punya induk untuk ditanya dan selalu ada.
 *  - `unreachable` — induk datang kosong atau tidak bisa dibaca sama sekali. Ia tidak mungkin
 *    tidak-beranak, karena ia memuat kita, jadi ini berarti kita tidak bisa melihat filesystem-nya.
 *  - `unknown` — BENTUK path-nya membuat tidak ada listing induk yang bisa menjawab. Benar-benar
 *    nol informasi, jadi pemanggil tetap bilang "empty". Meremehkan lebih baik daripada memberi
 *    tahu seseorang foldernya terhapus karena satu `ls` gagal.
 *
 * Pencocokan per NAMA, bukan per `dir`, sengaja: symlink ke direktori bisa terdaftar sebagai entry
 * non-dir, dan salah mengiranya "missing" adalah alarm palsu yang justru dihindari fungsi ini.
 */
export function classifyEmptyListing(
  cwd: string,
  /** Entry milik induk, atau `null` saat induk tidak ditanya / tidak bisa dibaca. */
  parentEntries: readonly { name: string }[] | null
): EmptyListingVerdict {
  const trimmed = cwd.replace(/\/+$/, '')
  const name = folderTitle(cwd)
  if (name === '/' || !trimmed) return 'empty' // root: tanpa induk, selalu ada

  // Di bawah ini adalah path yang listing induknya TIDAK BISA menjawab. Masing-masing akan gagal
  // cocok-nama dan dilaporkan `missing` — "folder Anda hilang" palsu atas direktori yang sempurna
  // terbaca, satu-satunya error yang keberadaan classifier ini justru untuk mencegahnya.
  //  - Tidak absolut-`/`: `~` yang paling penting — server yang mengembangkannya (`expandHomePath`),
  //    jadi `fs.list('~')` berhasil, tapi `parentDir('~')` adalah '/' dan '/' tidak punya entry `~`.
  //  - Segmen `.` / `..` — `readdir` tidak pernah memancarkannya.
  //  - `.git`, yang memang dibuang jalur listing (`fsOps.listDir`), jadi node yang menunjuk ke
  //    sana tidak akan pernah menemukan dirinya di induknya.
  if (!trimmed.startsWith('/') || name === '.' || name === '..' || name === '.git') return 'unknown'

  if (!parentEntries || parentEntries.length === 0) return 'unreachable'
  if (parentEntries.some((e) => e.name === name)) return 'empty'
  // Filesystem case-insensitive (APFS) mendaftar direktori dengan baik meski case cwd berbeda dari
  // ejaan di disk, dan `readdir` menjawab dengan ejaan di disk. Anggap ada: cocok case-folded
  // adalah bukti keberadaan yang lebih lemah, tapi "missing" harus jadi kesimpulan yang KITA YAKIN.
  const lower = name.toLowerCase()
  if (parentEntries.some((e) => e.name.toLowerCase() === lower)) return 'empty'
  return 'missing'
}

/**
 * Filter entry berdasarkan substring, case-insensitive. Query kosong atau hanya spasi mencocokkan
 * semuanya — kotak filter yang diam-diam menyembunyikan seluruh listing ketika pengguna
 * select-all lalu delete adalah bug yang dijaga di sini.
 */
export function filterEntries<T extends { name: string }>(entries: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'weba'])

// Ekstensi yang hanya bisa ditangani OS — tidak ada editor/preview yang bisa merendernya jadi
// sesuatu yang berguna. Apa pun yang TIDAK ada di set ini terbuka sebagai node preview (teks,
// kode, gambar, atau file config tanpa ekstensi).
const OS_OPEN_EXTENSIONS = new Set([
  'dmg', 'pkg', 'app', 'zip', 'gz', 'tar', 'tgz', 'rar', '7z',
  'exe', 'msi', 'deb', 'rpm', 'iso',
  'sqlite', 'db', 'bin', 'dat', 'wasm',
  ...VIDEO_EXTS, ...AUDIO_EXTS,
])

/** Ekstensi lowercase dari satu segmen path, atau '' bila tidak ada. */
function extensionOf(segment: string): string {
  const dot = segment.lastIndexOf('.')
  return dot <= 0 ? '' : segment.slice(dot + 1).toLowerCase()
}

/** True bila path terlihat seperti file media yang bisa diputar (per ekstensi). */
export function isMediaFile(path: string): boolean {
  const ext = extensionOf(path.split('/').filter(Boolean).pop() ?? '')
  return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)
}

/** Apakah file terbuka sebagai node preview/editor? Setiap SEGMEN diperiksa, bukan hanya basename:
 *  file di dalam bundle/arsip OS (`App.app/Contents/Info`) juga bukan urusan editor. */
export function opensInEditor(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0) return true
  return !segments.some((segment) => OS_OPEN_EXTENSIONS.has(extensionOf(segment)))
}

/**
 * Apa yang seharusnya dilakukan saat membuka sebuah FILE.
 *
 *  `canvas` — buka sebagai node di canvas (editor untuk teks/gambar, player untuk media).
 *  `os`     — serahkan ke aplikasi default sistem operasi.
 *
 * BEDA DARI nodeterm: webterm SELALU tab browser, dan tab browser tidak bisa menyerahkan file ke
 * OS mesin server. Jadi `os` di sini bukan aksi, ia VERDIKT "tidak bisa dibuka dari sini" — persis
 * cabang browser-runtime yang sudah ada di nodeterm. Pemanggil memberi tahu pengguna alih-alih
 * membuka buffer sampah; itu juga alasan `fsLimits.ts` memaksa file kelewat besar MENOLAK dibuka
 * ketimbang terbuka kosong.
 */
export function fileOpenTarget(path: string): 'canvas' | 'os' {
  if (isMediaFile(path)) return 'canvas'
  return opensInEditor(path) ? 'canvas' : 'os'
}

/**
 * Entry milik `to` yang menuntun kembali ke arah `from`, bila `to` adalah ancestor ketat darinya —
 * jadi naik (tombol ↑, Backspace, sebuah breadcrumb) mendarat dengan folder yang baru ditinggalkan
 * dalam keadaan terpilih, seperti Windows Explorer dan Finder. `null` bila `to` bukan ancestor
 * (masuk ke subfolder, atau lompat ke tempat lain), yang berarti "jangan pilih apa pun".
 */
export function childOnPath(to: string, from: string): string | null {
  if (to.startsWith('/') !== from.startsWith('/')) return null
  const a = to.split('/').filter(Boolean)
  const b = from.split('/').filter(Boolean)
  if (b.length <= a.length) return null
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return null
  return b[a.length]
}
