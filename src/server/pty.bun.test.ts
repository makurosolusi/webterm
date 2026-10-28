// Bun-only (butuh Bun.Terminal + PTY nyata); dijalankan lewat `bun test`, dikecualikan dari vitest
// via sufiks **/*.bun.test.ts. Memakai hanya toBe/toContain, matcher yang dideklarasikan di
// src/server/bun-test.d.ts.
import { test, expect } from 'bun:test'
import { spawnPty } from './pty'

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

test('kill() menyapu cucu yang sudah lepas dari SIGHUP, bukan hanya pid anak', async () => {
  let out = ''
  // `sleep &` lalu shell menunggu: cucu ini TIDAK ikut mati saat master PTY ditutup maupun saat
  // pid anak disinyal — persis zombie yang dikeluhkan.
  const pty = spawnPty({
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    cmd: 'sleep 47 & echo GRANDCHILD=$!; sleep 45',
  })
  pty.onData((d) => {
    out += d
  })

  const m = await readUntil(() => out, /GRANDCHILD=(\d+)/, 3000)
  expect(m !== null).toBe(true)
  const grandchild = Number(m?.[1])
  expect(Number.isInteger(grandchild)).toBe(true)
  expect(alive(grandchild)).toBe(true) // prasyarat: cucu memang hidup sebelum kill()

  pty.kill()

  try {
    expect(await waitGone(grandchild, 3000)).toBe(true)
    expect(await waitGone(pty.pid, 3000)).toBe(true)
  } finally {
    // Jangan tinggalkan proses menggantung kalau assertion di atas gagal. Hanya pid yang
    // di-spawn test ini sendiri.
    if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    if (alive(pty.pid)) process.kill(pty.pid, 'SIGKILL')
  }
})
