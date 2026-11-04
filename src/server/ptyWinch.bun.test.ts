// Bun-only: jalur ini BUTUH PTY nyata. Yang dijaga di sini bukan "apakah angka winsize tersimpan",
// melainkan "apakah program di dalam PTY DIBERI TAHU bahwa ukurannya berubah" — dan satu-satunya
// cara membuktikannya adalah menjalankan program yang memasang handler SIGWINCH lalu membaca
// ulang ukuran tty-nya. Tidak bisa hidup di vitest. Memakai hanya toBe/toContain, matcher yang
// dideklarasikan di src/server/bun-test.d.ts.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPty } from './pty'

/** HOME kosong khusus file ini, dipakai setiap `spawnPty` di bawah. Yang diuji di sini adalah
 *  penyampaian SIGWINCH/winsize ke pemegang layar turunan, BUKAN shell rc milik user: `bash -l`
 *  membaca `~/.bash_profile`, dan profil yang berat (brew/pyenv/nvm/rvm/conda) hanya menambah
 *  latensi start yang tidak berhubungan dengan jalur WINCH — diukur 0,65 s idle dan >4 s median saat
 *  24 shell start bersamaan. Dengan HOME ini `bash -l` hanya membaca `/etc/profile`, jadi anggaran
 *  `READ_BUDGET_MS` benar-benar mengukur jalur yang diuji, bukan kecepatan rc user. */
const PTY_HOME = mkdtempSync(join(tmpdir(), 'webterm-pty-home-'))

// Perilaku LAMA: `Bun.spawn` diberi objek `new Bun.Terminal(...)` yang sudah jadi. Winsize termios
// MEMANG ikut diperbarui — `stty size` di dalam PTY berubah — tapi bentuk objek itu tidak memanggil
// setsid/TIOCSCTTY, jadi tty-nya tak punya foreground process group (diukur pada Bun 1.4.2:
// `ps -o tpgid` → 0; dilaporkan upstream sebagai oven-sh/bun#33237). Tanpa foreground group, kernel
// tidak punya siapa pun untuk disinyali, jadi handler WINCH di dalam PTY TIDAK PERNAH JALAN: nol
// baris geometri baru.
const OLD_GEOMETRY_LINES_AFTER_RESIZE = 0
// Konsekuensinya bagi TUI full-screen (Claude Code, vim, tmux): ia terus menggambar pada geometri
// yang dibacanya saat start. Inilah angka yang "menempel" dan jadi gejala yang dilaporkan pengguna —
// node diperbesar tapi frame-nya tetap sekecil ini, menyisakan ruang kosong di kanan dan bawah.
const OLD_STUCK_GEOMETRY = '24 80'
// Perilaku LAMA sesudah SIGWINCH dipasang tapi SEBELUM gerbang perubahan: `TerminalCore` mengirim
// `resize` pada setiap detak ResizeObserver tanpa membandingkan apa pun, jadi setiap detak dengan
// ukuran yang SAMA tetap menghasilkan satu sinyal — artinya satu redraw penuh TUI per detak.
const OLD_SIGNALS_PER_DUPLICATE_RESIZE = 1

/** Ukuran awal PTY test. Dinamai karena dipakai dua kali (spawn + predikat `OLD_STUCK_GEOMETRY`). */
const START_COLS = 80
const START_ROWS = 24

/** `stty size` mencetak "ROWS COLS" — kebalikan dari urutan argumen `resize(cols, rows)`. */
const geometry = (cols: number, rows: number): string => `${rows} ${cols}`

/** Program di dalam PTY: cetak geometri sekali saat start, lalu cetak ulang setiap kali SIGWINCH
 *  datang. Sengaja TANPA `$` sama sekali — baris ini diserahkan ke login shell lewat `-c`, jadi
 *  `$(...)` akan diekspansi shell LUAR saat peluncuran dan membekukan angkanya di ukuran awal
 *  (jebakan yang sempat memberi hasil palsu saat jalur ini diukur).
 *
 *  Pembungkus `bash -c "..."` plus `; :` di belakang BUKAN hiasan: tanpa perintah di belakangnya,
 *  login shell akan meng-`exec` bash itu sehingga pemegang trap menjadi pid anak sendiri. Dengan
 *  `; :` ia tetap proses terpisah, jadi pemegang trap adalah KETURUNAN — bentuk yang sama dengan
 *  produksi, di mana `cmd` dijalankan lewat login shell sehingga `claude` adalah cucu. */
const WINCH_REPORTER =
  `bash -c "stty size; trap 'stty size' WINCH; while :; do sleep 0.2; done" ; :`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: prosesnya sudah keluar. Di sini hanya dipakai untuk pembersihan, jadi tidak ada yang
    // perlu dipropagasikan — proses yang sudah mati justru keadaan yang diinginkan.
    return false
  }
}

/** Tunggu `re` muncul di output dengan polling pendek berbatas, bukan satu `sleep` panjang (pola
 *  `pty.bun.test.ts`): peluncuran shell biasanya selesai dalam puluhan milidetik, jadi test selesai
 *  cepat dan tetap punya plafon tegas kalau jalurnya rusak. */
async function readUntil(seen: () => string, re: RegExp, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (re.test(seen())) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

/** Jeda antar resize duplikat di test gerbang. HARUS lebih panjang dari `sleep 0.2` di
 *  `WINCH_REPORTER`: bash menjalankan trap hanya di antara dua perintah, dan sinyal POSIX tidak
 *  diantrekan. Tanpa jeda ini dua SIGWINCH beruntun bisa menyatu jadi satu trap — dan test akan
 *  hijau karena penyatuan sinyal, bukan karena gerbangnya bekerja. */
const DUPLICATE_GAP_MS = 320

/** Berapa kali ukuran IDENTIK diminta ulang sesudah yang pertama. Dipakai untuk menghitung angka
 *  yang akan dihasilkan perilaku lama, supaya predikatnya terbukti membedakan keduanya. */
const DUPLICATE_RESIZES = 2

/** Anggaran satu putaran `readUntil`. Yang dibatasi di sini adalah KESABARAN, bukan kecepatan: tiap
 *  putaran menunggu login shell NYATA (`bash -l`, baca rc) lalu satu trap bash. Angka 6 s yang
 *  dipakai sebelumnya membuat mesin yang sedang sibuk terbaca sebagai jalur yang rusak — diukur:
 *  shell yang biasanya mencetak baris pertamanya dalam ~0,7 s bisa lewat 6 s saat load average 6.
 *  Plafon 15 s pun ternyata masih kalah saat seluruh `bun test` berjalan paralel, jadi dinaikkan ke
 *  30 s. Jalur yang benar-benar rusak tidak pernah mencetak apa pun, jadi menaikkan plafon hanya
 *  menunda merah yang sah, tidak menyembunyikannya. */
const READ_BUDGET_MS = 30_000

/** Batas per-test. Anggaran polling di dalam kedua test ini sejak awal melebihi batas default
 *  `bun test` yang 5 s, jadi keduanya hanya hijau selama login shell nyata kebetulan start cepat —
 *  di suite penuh yang sibuk ia merah sebagai timeout runner, merah yang tidak menyebut apa pun
 *  tentang apa yang salah. Nilainya menutup seluruh anggaran di test terpanjang: tiga putaran
 *  `READ_BUDGET_MS` (3 x 30 s) plus jeda duplikat 320 ms, dengan sisa ruang untuk mesin yang sedang
 *  sibuk. Jalur yang benar-benar rusak tetap gagal pada putaran PERTAMA (~30 s), jadi plafon ini
 *  hanya menyerap kelambatan, bukan menutupi kerusakan. Lihat catatan yang sama di `pty.bun.test.ts`. */
const PTY_TEST_TIMEOUT_MS = 120_000

test('resize memberi tahu pemegang layar yang merupakan keturunan, bukan hanya pid anak', async () => {
  let out = ''
  const pty = spawnPty({
    cols: START_COLS,
    rows: START_ROWS,
    cwd: '/tmp',
    cmd: WINCH_REPORTER,
    env: { HOME: PTY_HOME },
  })
  pty.onData((d) => {
    out += d
  })

  try {
    // Prasyarat 1: program di dalam PTY sudah jalan dan membaca ukuran awalnya.
    expect(await readUntil(() => out, new RegExp(OLD_STUCK_GEOMETRY), READ_BUDGET_MS)).toBe(true)

    // Prasyarat 2 — inilah yang membuat test ini menggigit: pemegang trap BUKAN pid anak, jadi
    // menyinyal `proc.pid` saja tidak akan mencetak apa pun (login shell mengabaikan SIGWINCH).
    // Yang membuatnya tetap sampai adalah foreground process group: anak dan keturunannya satu
    // grup, dan kernel menyinyali seluruh grup saat winsize berubah.
    const forked = execFileSync('ps', ['-Ao', 'ppid='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => Number(line.trim()) === pty.pid).length
    expect(forked > 0).toBe(true)

    const before = out.length
    pty.resize(160, 50)
    expect(await readUntil(() => out, new RegExp(geometry(160, 50)), READ_BUDGET_MS)).toBe(true)

    // Predikatnya dinyatakan dua kali dengan sengaja: baris geometri BARU harus ada, dan jumlahnya
    // bukan nol — angka yang dihasilkan perilaku lama, ketika winsize berubah tanpa ada yang
    // diberi tahu.
    const lines = occurrences(out.slice(before), geometry(160, 50))
    expect(lines > OLD_GEOMETRY_LINES_AFTER_RESIZE).toBe(true)
    expect(out.slice(before)).toContain(geometry(160, 50))
  } finally {
    pty.kill()
    if (alive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
  }
}, PTY_TEST_TIMEOUT_MS)

test('resize ke ukuran yang sama tidak menyinyal lagi, ukuran baru tetap lewat', async () => {
  let out = ''
  const pty = spawnPty({
    cols: START_COLS,
    rows: START_ROWS,
    cwd: '/tmp',
    cmd: WINCH_REPORTER,
    env: { HOME: PTY_HOME },
  })
  pty.onData((d) => {
    out += d
  })

  try {
    expect(await readUntil(() => out, new RegExp(OLD_STUCK_GEOMETRY), READ_BUDGET_MS)).toBe(true)
    const before = out.length

    pty.resize(160, 50)
    expect(await readUntil(() => out, new RegExp(geometry(160, 50)), READ_BUDGET_MS)).toBe(true)

    // Dua detak ResizeObserver berikutnya dengan ukuran IDENTIK — bentuk yang dikirim client saat
    // node disentuh tanpa benar-benar melewati batas sel. Jedanya cukup panjang supaya tiap sinyal
    // pasti terlayani bila memang terkirim (lihat `DUPLICATE_GAP_MS`).
    await new Promise((r) => setTimeout(r, DUPLICATE_GAP_MS))
    pty.resize(160, 50)
    await new Promise((r) => setTimeout(r, DUPLICATE_GAP_MS))
    pty.resize(160, 50)
    // Ukuran tak masuk akal (`fit()` pada elemen 0x0) juga tidak boleh jadi sinyal, DAN tidak boleh
    // merusak ukuran tersimpan — resize sah di bawah ini membuktikan keduanya.
    pty.resize(0, 50)
    await new Promise((r) => setTimeout(r, DUPLICATE_GAP_MS))

    // Tepat satu redraw untuk tiga permintaan ukuran sama. Perilaku lama memberi satu sinyal per
    // permintaan, jadi angkanya 1 + DUPLICATE_RESIZES — itulah badai yang dicegah gerbang ini.
    const repeats = occurrences(out.slice(before), geometry(160, 50))
    expect(repeats).toBe(1)
    expect(repeats).not.toBe(1 + DUPLICATE_RESIZES * OLD_SIGNALS_PER_DUPLICATE_RESIZE)

    // Arah sebaliknya, dan ini yang jauh lebih penting daripada bug aslinya: gerbang yang terlalu
    // rakus akan MEMBEKUKAN terminal pada satu ukuran. Ukuran baru wajib tetap lewat.
    pty.resize(100, 30)
    expect(await readUntil(() => out, new RegExp(geometry(100, 30)), READ_BUDGET_MS)).toBe(true)
    expect(out.slice(before)).toContain(geometry(100, 30))
  } finally {
    pty.kill()
    if (alive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
  }
}, PTY_TEST_TIMEOUT_MS)
