// `gitInfo.ts` terhadap repo git NYATA di direktori temporer. Bun-only karena yang diuji adalah
// keluaran git asli: `Bun.spawn`/`execFile` yang dimock cuma menguji mocknya sendiri, dan justru
// parsing keluaran git itulah yang bisa salah. Hanya memakai matcher yang dibuka deklarasi ambient
// `bun:test` (src/server/bun-test.d.ts).
//
// Timeout per-test dinaikkan: satu test di sini men-spawn 5-10 proses git, dan batas default
// `bun test` 5 s terlalu rapat untuk itu di mesin yang sibuk — kegagalannya akan muncul sebagai
// timeout runner, bukan sebagai assertion yang salah.
import { test, expect } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { collectGitInfo, gitInfoRoute } from './gitInfo'
import { GIT_INFO_MAX_PATHS, GIT_INFO_PATH, type GitInfoResponse } from '../shared/gitInfo'

const run = promisify(execFile)
const TEST_TIMEOUT_MS = 30_000

/** git di dalam fixture, terisolasi dari config pengguna: `GIT_CONFIG_GLOBAL=/dev/null` mematikan
 *  `init.defaultBranch`, hooksPath, dan template apa pun yang kebetulan dipasang di mesin ini —
 *  tanpa itu test lulus/gagal tergantung ~/.gitconfig siapa yang menjalankannya. */
function g(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
  return run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'webterm test',
      GIT_AUTHOR_EMAIL: 't@webterm.test',
      GIT_COMMITTER_NAME: 'webterm test',
      GIT_COMMITTER_EMAIL: 't@webterm.test',
    },
  })
}

/** Fixture di direktori temporer sendiri, dibereskan apa pun hasil `fn`. Tidak ada tulisan di luar
 *  `$TMPDIR` — lihat catatan `sun_path`/TMPDIR di CLAUDE.md. */
async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-git-'))
  try {
    await fn((...segs: string[]) => npath.join(root, ...segs))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** Repo dengan satu commit di branch `main`, bersih. */
async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await g(dir, 'init', '-q', '-b', 'main')
  await fs.writeFile(npath.join(dir, 'tracked.txt'), 'satu\n')
  await g(dir, 'add', 'tracked.txt')
  await g(dir, 'commit', '-q', '-m', 'init')
}

/**
 * Jalankan `fn` dengan sebuah shim `git` di depan PATH yang mencatat tiap invokasi lalu
 * meneruskannya ke git sungguhan. SATU-SATUNYA cara membuktikan klaim efisiensi: jumlah proses
 * yang di-spawn tidak terlihat dari nilai yang dipulangkan. `execFile` mencari executable lewat
 * PATH di env yang diberikan, dan `gitInfo.ts` menyebar `process.env` saat memanggil, jadi mutasi
 * di sini terbaca olehnya.
 */
async function withGitLog(fn: () => Promise<void>): Promise<string[]> {
  const realGit = (await run('which', ['git'])).stdout.trim()
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-gitshim-'))
  const log = npath.join(dir, 'calls.log')
  const shim = npath.join(dir, 'git')
  await fs.writeFile(shim, `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`)
  await fs.chmod(shim, 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}:${prev ?? ''}`
  try {
    await fn()
    // Log dibaca SEBELUM shim dibereskan: ia tinggal di direktori yang sama.
    return (await fs.readFile(log, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
  } finally {
    process.env.PATH = prev
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Jalankan `fn` dengan `git` yang keluar 1 tanpa keluaran untuk `status`, dan meneruskan sisanya
 *  ke git sungguhan. Satu-satunya cara memaksa cabang "git tidak bisa menjawab" tanpa mount
 *  jaringan yang mati; sebuah shim yang menggantung akan membayar GIT_TIMEOUT_MS penuh. */
async function withFailingStatus(fn: () => Promise<void>): Promise<void> {
  const realGit = (await run('which', ['git'])).stdout.trim()
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-gitfail-'))
  const shim = npath.join(dir, 'git')
  await fs.writeFile(
    shim,
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && exit 1; done\nexec '${realGit}' "$@"\n`
  )
  await fs.chmod(shim, 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}:${prev ?? ''}`
  try {
    await fn()
  } finally {
    process.env.PATH = prev
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test(
  'a clean repo reports its root, branch, short head, and no dirt',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      const [info] = await collectGitInfo([at('repo')])
      expect(info.path).toBe(at('repo'))
      expect(info.state).toBe('repo')
      // git memulangkan root yang sudah di-realpath (/tmp -> /private/tmp di macOS), jadi yang
      // dibandingkan adalah realpath-nya, bukan string yang kita minta.
      expect(info.repo?.root).toBe(await fs.realpath(at('repo')))
      expect(info.repo?.branch).toBe('main')
      expect(info.repo?.head.length).toBe(7)
      expect(info.repo?.dirty).toBe(false)
      expect(info.repo?.upstream).toBe(null)
      expect(info.repo?.ahead).toBe(0)
      expect(info.repo?.behind).toBe(0)
    })
  },
  TEST_TIMEOUT_MS
)

// Tiga bentuk kotor yang berbeda, satu per satu: dulu `--porcelain` tanpa `-uall` melewatkan
// untracked di dalam subdirektori, dan file yang di-gitignore TIDAK boleh membuat badge menyala.
test(
  'a modified file, a staged file, and an untracked file each count as dirty; an ignored one does not',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      const dirty = async (): Promise<boolean | undefined> =>
        (await collectGitInfo([at('repo')]))[0].repo?.dirty

      await fs.writeFile(at('repo', '.gitignore'), 'noise.log\n')
      await g(at('repo'), 'add', '.gitignore')
      await g(at('repo'), 'commit', '-q', '-m', 'ignore')
      await fs.writeFile(at('repo', 'noise.log'), 'x')
      expect(await dirty()).toBe(false)

      await fs.mkdir(at('repo', 'sub'))
      await fs.writeFile(at('repo', 'sub', 'new.txt'), 'x')
      expect(await dirty()).toBe(true)
      await fs.rm(at('repo', 'sub'), { recursive: true })

      await fs.writeFile(at('repo', 'tracked.txt'), 'dua\n')
      expect(await dirty()).toBe(true)
      await g(at('repo'), 'add', 'tracked.txt')
      expect(await dirty()).toBe(true)
    })
  },
  TEST_TIMEOUT_MS
)

test(
  'a detached HEAD reports a null branch and still reports the oid',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      const head = (await g(at('repo'), 'rev-parse', 'HEAD')).stdout.trim()
      await g(at('repo'), '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', head)
      const [info] = await collectGitInfo([at('repo')])
      expect(info.state).toBe('repo')
      expect(info.repo?.branch).toBe(null)
      expect(info.repo?.head).toBe(head.slice(0, 7))
    })
  },
  TEST_TIMEOUT_MS
)

test(
  'ahead and behind come from the upstream header, and behind is not negative',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      await g(at('repo'), 'checkout', '-q', '-b', 'feature')
      await g(at('repo'), 'branch', '-q', '--set-upstream-to=main', 'feature')
      await g(at('repo'), 'commit', '-q', '--allow-empty', '-m', 'a')
      await g(at('repo'), 'commit', '-q', '--allow-empty', '-m', 'b')
      const ahead = (await collectGitInfo([at('repo')]))[0].repo
      expect(ahead?.branch).toBe('feature')
      expect(ahead?.upstream).toBe('main')
      expect(ahead?.ahead).toBe(2)
      expect(ahead?.behind).toBe(0)

      // Sisi sebaliknya dari dua commit yang sama: main tertinggal 2 dari feature.
      await g(at('repo'), 'branch', '-q', '--set-upstream-to=feature', 'main')
      await g(at('repo'), 'checkout', '-q', 'main')
      const behind = (await collectGitInfo([at('repo')]))[0].repo
      expect(behind?.ahead).toBe(0)
      expect(behind?.behind).toBe(2)
    })
  },
  TEST_TIMEOUT_MS
)

// "Bukan repo" dan "tidak ada" adalah dua jawaban yang berbeda, dan keduanya normal — bukan
// exception, bukan 500. Bedanya dibaca dari `stat`, bukan dari teks stderr git yang bergantung
// locale.
test(
  'a plain directory is not-a-repo, a missing path is missing, and neither throws',
  async () => {
    await withTmp(async (at) => {
      await fs.mkdir(at('plain'))
      const [plain, ghost] = await collectGitInfo([at('plain'), at('ghost')])
      expect(plain.state).toBe('not-a-repo')
      expect(plain.repo).toBe(null)
      expect(ghost.state).toBe('missing')
      expect(ghost.repo).toBe(null)
    })
  },
  TEST_TIMEOUT_MS
)

test(
  'a repo with no commit yet answers with a branch and an empty head',
  async () => {
    await withTmp(async (at) => {
      await fs.mkdir(at('fresh'))
      await g(at('fresh'), 'init', '-q', '-b', 'main')
      const [info] = await collectGitInfo([at('fresh')])
      expect(info.state).toBe('repo')
      expect(info.repo?.branch).toBe('main')
      expect(info.repo?.head).toBe('')
    })
  },
  TEST_TIMEOUT_MS
)

// INTI klaim anti-N+1. Lima path: tiga di repo A (satu di antaranya duplikat, satu subdirektori),
// satu di repo B, satu bukan repo. Yang harus terjadi: `status` SEKALI per repo, bukan sekali per
// path, dan path yang sama tidak men-spawn apa pun dua kali.
test(
  'many cwds in one repo cost one status per repo, and a duplicate cwd costs nothing',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('a'))
      await initRepo(at('b'))
      await fs.mkdir(at('a', 'sub'))
      await fs.mkdir(at('plain'))
      const paths = [at('a'), at('a', 'sub'), at('a'), at('b'), at('plain')]
      let out: Awaited<ReturnType<typeof collectGitInfo>> = []

      const calls = await withGitLog(async () => {
        out = await collectGitInfo(paths)
      })

      // Jawabannya tetap satu entry per path yang diminta, duplikat ikut terjawab.
      expect(out.length).toBe(5)
      expect(out[0].repo?.root).toBe(out[1].repo?.root)
      expect(out[0].repo?.root).toBe(out[2].repo?.root)
      expect(out[3].repo?.root).toBe(await fs.realpath(at('b')))
      expect(out[4].state).toBe('not-a-repo')

      const statusCalls = calls.filter((c) => c.includes(' status '))
      const topCalls = calls.filter((c) => c.includes('rev-parse'))
      // Dua repo -> dua `status`. Lima path (empat unik) -> tiga `status` kalau dedupe per repo
      // hilang, lima kalau dedupe path juga hilang.
      expect(statusCalls.length).toBe(2)
      // Satu `rev-parse` per path UNIK: 4, bukan 5.
      expect(topCalls.length).toBe(4)
    })
  },
  TEST_TIMEOUT_MS
)

test(
  'an empty list answers with no results and spawns no git at all',
  async () => {
    let out: Awaited<ReturnType<typeof collectGitInfo>> = [{ path: 'x', state: 'error', repo: null }]
    const calls = await withGitLog(async () => {
      out = await collectGitInfo([])
    })
    expect(out.length).toBe(0)
    expect(calls.length).toBe(0)
  },
  TEST_TIMEOUT_MS
)

// git yang tidak bisa menjawab BUKAN "bukan repo": melipat keduanya akan membuat badge UI
// mengklaim sebuah repo bukan repo setiap kali `status` kehabisan waktu.
test(
  'a repo whose status cannot be read is error, not not-a-repo',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      await withFailingStatus(async () => {
        const [info] = await collectGitInfo([at('repo')])
        expect(info.state).toBe('error')
        expect(info.repo).toBe(null)
      })
    })
  },
  TEST_TIMEOUT_MS
)

const body = (v: unknown) => () => Promise.resolve(JSON.stringify(v))

test(
  'the route answers a well-formed batch at 200 with one result per requested path',
  async () => {
    await withTmp(async (at) => {
      await initRepo(at('repo'))
      const r = await gitInfoRoute(GIT_INFO_PATH, 'POST', body({ paths: [at('repo'), at('repo')] }))
      expect(r?.status).toBe(200)
      const out = r?.body as GitInfoResponse
      expect(out.results.length).toBe(2)
      expect(out.results[0].repo?.branch).toBe('main')
    })
  },
  TEST_TIMEOUT_MS
)

test('an unusable body is 400, never a crash and never a 500', async () => {
  expect((await gitInfoRoute(GIT_INFO_PATH, 'POST', () => Promise.resolve('{nope')))?.status).toBe(400)
  // JSON yang sah tapi bentuknya salah: dulu kelas bug ini lolos parse lalu melempar saat properti
  // dibaca, dan responsnya tidak pernah ditutup (client menggantung).
  for (const v of [null, 42, 'teks', [], {}, { paths: 'x' }, { paths: [1] }, { paths: ['  '] }]) {
    expect((await gitInfoRoute(GIT_INFO_PATH, 'POST', body(v)))?.status).toBe(400)
  }
  const tooMany = Array.from({ length: GIT_INFO_MAX_PATHS + 1 }, () => '/tmp')
  expect((await gitInfoRoute(GIT_INFO_PATH, 'POST', body({ paths: tooMany })))?.status).toBe(400)
})

test('a foreign path or method returns null so the caller falls through to its own 404', async () => {
  expect(await gitInfoRoute('/api/fs', 'POST', body({}))).toBe(null)
  expect(await gitInfoRoute(GIT_INFO_PATH, 'GET', body({}))).toBe(null)
  expect(await gitInfoRoute(GIT_INFO_PATH, 'DELETE', body({}))).toBe(null)
})
