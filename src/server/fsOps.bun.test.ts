// Kontrak dua-paruh `fsOps.ts` terhadap filesystem NYATA: pembacaan isi melempar, penelusuran
// tetap fail-open. Bun-only karena yang diuji adalah errno asli dari `fs.*` (EACCES/EISDIR hanya
// muncul dari file nyata; fs yang dimock cuma menguji mock-nya sendiri). Hanya memakai matcher
// yang diekspos deklarasi ambient `bun:test` (src/server/bun-test.d.ts).
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { listDir, pathExists, readBinary, readErrorResult, readText } from './fsOps'

/** Fixture di direktori temporer sendiri, dibereskan apa pun hasil `fn`. Tidak ada tulisan di
 *  luar `$TMPDIR` — lihat catatan `sun_path`/TMPDIR di CLAUDE.md. */
async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fsread-'))
  try {
    await fn((...segs: string[]) => npath.join(root, ...segs))
  } finally {
    // chmod dipulihkan dulu: direktori 000 membuat `rm -r` sendiri gagal dan fixture tertinggal.
    await fs.chmod(npath.join(root, 'locked.txt'), 0o600).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** Kegagalan baca yang tertangkap, atau null kalau pembacaan justru berhasil. */
async function readError(read: () => Promise<string>): Promise<unknown> {
  try {
    await read()
    return null
  } catch (err) {
    return err
  }
}

// INI assertion intinya: kosong adalah jawaban yang SAH untuk sebuah file, jadi ia tidak boleh
// lewat jalur kegagalan. Kalau test ini merah, editor akan menolak membuka file kosong.
test('an empty file reads as an empty string, and that is a success', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('empty.txt'), '')
    expect(await readText(at('empty.txt'))).toBe('')
    expect(await readBinary(at('empty.txt'))).toBe('')
  })
})

test('a missing file is reported as a failure, not as empty content', async () => {
  await withTmp(async (at) => {
    const err = await readError(() => readText(at('ghost.txt')))
    expect(err instanceof Error).toBe(true)
    expect((err as Error).message).toContain('fs read failed')
    expect(readErrorResult(err).status).toBe(404)
    expect(readErrorResult(await readError(() => readBinary(at('ghost.bin')))).status).toBe(404)
  })
})

test('a path that is really a directory is reported as a failure', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('adir'))
    const err = await readError(() => readText(at('adir')))
    expect(err instanceof Error).toBe(true)
    // EISDIR di macOS/Linux; 400 karena permintaannya yang salah, bukan servernya.
    expect(readErrorResult(err).status).toBe(400)
  })
})

test('an unreadable file (chmod 000) is reported as a failure', async () => {
  // root menembus mode bit, jadi fixture-nya tidak membuktikan apa pun di sana.
  if (process.getuid?.() === 0) return
  await withTmp(async (at) => {
    await fs.writeFile(at('locked.txt'), 'secret')
    await fs.chmod(at('locked.txt'), 0o000)
    const err = await readError(() => readText(at('locked.txt')))
    expect(err instanceof Error).toBe(true)
    expect(readErrorResult(err).status).toBe(403)
    // Pesan ke pengguna tidak membawa path maupun isi file.
    expect(readErrorResult(err).body.error).toBe('permission denied')
  })
})

// Penjaga kontrak PENELUSURAN: `classifyEmptyListing` membedakan "kosong" dari "tidak ada" dengan
// bertanya ke induk, yang hanya sah selama `list`/`exists` tidak pernah melempar.
test('listDir and pathExists stay fail-open', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('empty-dir'))
    await fs.writeFile(at('a-file'), 'x')
    expect((await listDir(at('empty-dir'))).length).toBe(0)
    expect((await listDir(at('nope'))).length).toBe(0)
    expect((await listDir(at('a-file'))).length).toBe(0)
    expect(await pathExists(at('nope'))).toBe(false)
    expect(await pathExists(at('a-file'))).toBe(true)
  })
})

test('an unmapped cause falls back to 500 without leaking details', async () => {
  const out = readErrorResult(new Error('fs read failed: /home/u/x', { cause: new Error('weird') }))
  expect(out.status).toBe(500)
  expect(out.body.error).toBe('cannot read file')
})
