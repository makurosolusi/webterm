// Bun-only (butuh PTY nyata); dijalankan lewat `bun test`, dikecualikan dari vitest via sufiks
// **/*.bun.test.ts. Memakai hanya toBe/toContain, matcher yang dideklarasikan di
// src/server/bun-test.d.ts.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPty } from './pty'

/** HOME kosong khusus file ini, dipakai setiap `spawnPty` di bawah. Yang diuji di sini adalah sinyal
 *  line discipline dan sapuan keturunan, BUKAN shell rc milik user: `bash -l` membaca
 *  `~/.bash_profile`, dan profil yang berat (brew/pyenv/nvm/rvm/conda) hanya menambah latensi start
 *  yang tidak berhubungan dengan jalur yang diuji — diukur 0,65 s idle dan >4 s median saat 24 shell
 *  start bersamaan. Dengan HOME ini `bash -l` hanya membaca `/etc/profile`. */
const PTY_HOME = mkdtempSync(join(tmpdir(), 'webterm-pty-home-'))

/** Batas per-test. Default `bun test` 5 s terlalu sempit untuk jalur ini: tiap test di sini
 *  men-spawn login shell NYATA (`bash -l`, baca rc) lalu menunggu beberapa putaran polling. Tanpa
 *  batas eksplisit, test merah karena timeout runner saat suite penuh sedang sibuk — merah yang
 *  tidak bercerita apa-apa tentang apa yang salah. */
const PTY_TEST_TIMEOUT_MS = 90_000

/** Kesabaran menunggu login shell mencetak baris pertamanya. Bukan batas kecepatan: shell yang
 *  biasanya siap dalam ~0,7 s diukur bisa lewat 6 s saat mesin sibuk (load average 6), dan plafon
 *  15 s pun masih kalah saat seluruh `bun test` berjalan paralel — karena itu 30 s. Sedangkan jalur
 *  yang benar-benar rusak tidak pernah mencetak apa pun — jadi plafon tinggi menunda merah yang
 *  sah, tidak menyembunyikannya. */
const START_BUDGET_MS = 30_000

/** Kesabaran menunggu sebuah pid hilang. Dipisah dari `START_BUDGET_MS` dan sengaja JAUH lebih
 *  pendek: inilah predikat perilaku yang diuji (SIGINT dari line discipline, lalu grace
 *  SIGTERM→SIGKILL `KILL_GRACE_MS` di `pty.ts`), bukan peluncuran — jadi di sinilah test harus
 *  cepat merah kalau sinyalnya tidak sampai. Plafonnya hanya perlu melampaui grace itu. */
const GONE_BUDGET_MS = 6_000

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: proses sudah keluar — itu yang ingin dibuktikan test ini.
    return false
  }
}

/** Tunggu `pid` mati dengan polling pendek berbatas, bukan satu `sleep` panjang: SIGTERM biasanya
 *  langsung memakan `sleep`, jadi test selesai dalam milidetik dan tetap punya plafon tegas. */
async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive(pid)
}

async function readUntil(
  seen: () => string,
  re: RegExp,
  budgetMs: number
): Promise<RegExpExecArray | null> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const m = re.exec(seen())
    if (m || Date.now() > deadline) return m
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Proses foreground di dalam PTY, dibentuk persis seperti produksi: `cmd` diserahkan ke login
 *  shell (`shellArgv`), jadi pemegang layar adalah KETURUNAN, bukan pid anak. `; :` di belakang
 *  mencegah login shell meng-`exec` bash itu (jebakan yang sama dicatat di `ptyWinch.bun.test.ts`);
 *  `$$` dikutip tunggal supaya diekspansi bash DALAM, bukan shell luar saat peluncuran. */
const FOREGROUND_SLEEPER = `bash -c 'echo FG=$$; sleep 47' ; :`

test('Ctrl+C membunuh proses foreground di dalam PTY', async () => {
  let out = ''
  const pty = spawnPty({
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    cmd: FOREGROUND_SLEEPER,
    env: { HOME: PTY_HOME },
  })
  pty.onData((d) => {
    out += d
  })

  const m = await readUntil(() => out, /FG=(\d+)/, START_BUDGET_MS)
  expect(m !== null).toBe(true)
  const fg = Number(m?.[1])
  expect(alive(fg)).toBe(true) // prasyarat: ada yang bisa dibunuh

  // Satu byte ETX, persis yang dikirim keyboard pengguna lewat xterm. Yang diuji adalah PERILAKU
  // yang dikeluhkan ("htop tidak mau keluar dengan Ctrl+C"), bukan mekanismenya: kalau PTY ini
  // bukan controlling terminal anaknya, line discipline menerima byte ini tapi tak punya
  // foreground process group untuk disinyali, dan proses di bawah ini selamat.
  pty.write('\x03')

  try {
    expect(await waitGone(fg, GONE_BUDGET_MS)).toBe(true)
  } finally {
    pty.kill()
    if (alive(fg)) process.kill(fg, 'SIGKILL')
    if (alive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
  }
}, PTY_TEST_TIMEOUT_MS)

test('kill() menyapu cucu yang sudah lepas dari SIGHUP, bukan hanya pid anak', async () => {
  let out = ''
  // `sleep &` lalu shell menunggu: cucu ini TIDAK ikut mati saat master PTY ditutup maupun saat
  // pid anak disinyal — persis zombie yang dikeluhkan.
  const pty = spawnPty({
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    cmd: 'sleep 47 & echo GRANDCHILD=$!; sleep 45',
    env: { HOME: PTY_HOME },
  })
  pty.onData((d) => {
    out += d
  })

  const m = await readUntil(() => out, /GRANDCHILD=(\d+)/, START_BUDGET_MS)
  expect(m !== null).toBe(true)
  const grandchild = Number(m?.[1])
  expect(Number.isInteger(grandchild)).toBe(true)
  expect(alive(grandchild)).toBe(true) // prasyarat: cucu memang hidup sebelum kill()

  pty.kill()

  try {
    expect(await waitGone(grandchild, GONE_BUDGET_MS)).toBe(true)
    expect(await waitGone(pty.pid, GONE_BUDGET_MS)).toBe(true)
  } finally {
    // Jangan tinggalkan proses menggantung kalau assertion di atas gagal. Hanya pid yang
    // di-spawn test ini sendiri.
    if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    if (alive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
  }
}, PTY_TEST_TIMEOUT_MS)
