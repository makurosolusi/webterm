// Operasi filesystem sisi server untuk node files (dan pembaca file mana pun yang lewat
// `/api/fs/*`). Diadaptasi dari nodeterm `src/core/fs-ops.ts` (listDir/readText/readBinary/
// writeText/makeDir/pathExists) plus `expandHomePath` dari `src/core/fs-handlers.ts`.
//
// TIDAK DIPORT dari nodeterm: `listQuickOpenFiles` (rg/git-ls-files/walk — tidak ada permukaan
// quick-open di webterm), jalur sshFs, relay, dan tiket download. Dari 229 + 126 baris di sana
// yang relevan untuk 6 method ini hanya ±120 baris, bukan ±250.
//
// FAIL-OPEN ADALAH KONTRAK, BUKAN KELALAIAN. Tiap helper mengembalikan nilai kosong/false pada
// kegagalan alih-alih throw, dan client BERGANTUNG pada itu: `classifyEmptyListing`
// (src/client/fileBrowse.ts) memutuskan arti listing kosong dengan bertanya ke direktori INDUK,
// justru karena `list` tidak pernah throw. Mengubahnya jadi re-throw akan membuat empat empty
// state di UI runtuh jadi satu pesan error. Tiap catch di bawah karena itu mengembalikan nilai
// yang didokumentasikan, bukan `catch {}` kosong.
//
// KEAMANAN PATH — sengaja TIDAK ada jail. nodeterm mengambil keputusan yang sama
// (`src/core/relay/access-policy.ts`: "relay peers were fully trusted, so fs:read is not jailed";
// pemagaran hanya ada untuk peran relay non-editor, yang webterm tidak punya). Alasannya: siapa
// pun yang bisa menjangkau endpoint ini sudah bisa men-spawn PTY lewat `/ws`, jadi membatasi
// pembacaan file ke sebuah subtree adalah teater keamanan. Yang NYATA menjaga permukaan ini ada
// di lapisan transport — bind loopback + cek Origin + token (`src/server/auth.ts`). Tanggung
// jawab modul ini: `path.resolve` setiap input (di bawah) dan memberlakukan batas ukuran dari
// `src/shared/fsLimits.ts`.
//
// Isi file TIDAK PERNAH di-log di sini, sengaja: file yang dibaca pengguna bisa memuat kredensial.
import { promises as fs, type Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { FS_READ_BINARY_MAX_BYTES, FS_READ_MAX_BYTES, tooLargeSentinel } from '../shared/fsLimits'

const run = promisify(execFile)

/**
 * Satu entry direktori di wire. Kembarannya ada di `src/client/fileBrowse.ts` — dua deklarasi,
 * satu per sisi batas HTTP, karena `src/shared` final dan client tidak boleh menarik `node:fs`
 * ke dalam graph bundle-nya.
 */
export interface DirEntry {
  name: string
  dir: boolean
  /** Entry di-ignore oleh git — client meredamkan tampilannya. */
  ignored: boolean
}

/**
 * Kembangkan `~` / `~/` terhadap home directory MESIN INI. Harus terjadi di server: client adalah
 * tab browser yang tidak tahu home directory server. `~user` BUKAN path home-relative dan tetap
 * literal, sama seperti di nodeterm.
 */
export function expandHomePath(p: string, home: string = homedir()): string {
  return p === '~' || p.startsWith('~/') ? npath.join(home, p.slice(1)) : p
}

/** Path absolut yang ternormalisasi untuk sebuah input. Satu-satunya pintu masuk path di modul
 *  ini — lihat catatan keamanan di kepala file untuk apa yang dijamin dan apa yang tidak. */
export function resolveFsPath(p: string, home: string = homedir()): string {
  return npath.resolve(expandHomePath(p, home))
}

/**
 * Di atas jumlah entry ini `git check-ignore` dilewati sama sekali: argv-nya memuat SETIAP nama,
 * jadi direktori patologis (node_modules yang di-flat, direktori cache) akan menabrak ARG_MAX dan
 * membuat panggilannya gagal total — bukan sebagian.
 * ponytail: ambang tetap; pindah ke `git check-ignore --stdin` bila ada direktori nyata yang
 * entry-nya kehilangan flag `ignored` karena ambang ini.
 */
const GIT_CHECK_IGNORE_MAX_ENTRIES = 2000

/** Tandai entry yang di-gitignore. SATU proses `git` untuk seluruh direktori (bukan satu per
 *  entry — itu N+1 proses). Memutasi `entries` di tempat; tidak pernah throw. */
async function flagIgnored(dir: string, entries: DirEntry[]): Promise<void> {
  if (entries.length === 0 || entries.length > GIT_CHECK_IGNORE_MAX_ENTRIES) return
  const flag = (out: string): void => {
    const set = new Set(
      out
        .split('\n')
        .map((s) => s.trim().replace(/\/$/, ''))
        .filter(Boolean)
    )
    for (const en of entries) if (set.has(en.name)) en.ignored = true
  }
  try {
    const { stdout } = await run(
      'git',
      ['-C', dir, 'check-ignore', '--', ...entries.map((e) => e.name)],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    flag(stdout)
  } catch (err) {
    // `check-ignore` keluar non-nol untuk "tidak ada yang cocok" (1) dan "bukan repo git" (128) —
    // keduanya normal, bukan kegagalan. Exit 1 TETAP mencetak nama yang cocok bila ada sebagian,
    // jadi stdout dibaca ulang alih-alih dibuang.
    const out = (err as { stdout?: string }).stdout
    if (out) flag(out)
  }
}

/**
 * Daftar isi direktori: folder dulu lalu file, masing-masing alfabetis; `.git` disembunyikan;
 * entry yang di-gitignore ditandai. `[]` pada kegagalan apa pun — lihat kontrak fail-open di
 * kepala file.
 */
export async function listDir(dirPath: string): Promise<DirEntry[]> {
  const dir = resolveFsPath(dirPath)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return [] // fail-open: client yang memutuskan arti listing kosong
  }
  const entries: DirEntry[] = dirents
    .filter((e) => e.name !== '.git')
    // Symlink ke direktori melaporkan `isDirectory() === false`; itu diwarisi dari nodeterm dan
    // `classifyEmptyListing` memang mencocokkan per NAMA, bukan per `dir`, demi kasus ini.
    .map((e) => ({ name: e.name, dir: e.isDirectory(), ignored: false }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  await flagIgnored(dir, entries)
  return entries
}

/** Isi UTF-8 sebuah file. `''` pada kegagalan apa pun, sentinel too-large di atas cap. */
export async function readText(filePath: string): Promise<string> {
  const target = resolveFsPath(filePath)
  try {
    const { size } = await fs.stat(target)
    if (size > FS_READ_MAX_BYTES) return tooLargeSentinel(size)
    return await fs.readFile(target, 'utf-8')
  } catch {
    return ''
  }
}

/** Isi file sebagai base64 (preview gambar/biner). `''` pada kegagalan, sentinel di atas cap —
 *  cap-nya lebih besar tapi base64 masih menggelembungkan payload 1.33×. */
export async function readBinary(filePath: string): Promise<string> {
  const target = resolveFsPath(filePath)
  try {
    const { size } = await fs.stat(target)
    if (size > FS_READ_BINARY_MAX_BYTES) return tooLargeSentinel(size)
    return (await fs.readFile(target)).toString('base64')
  } catch {
    return ''
  }
}

/** Tulis teks UTF-8. `true` bila sukses, `false` pada kegagalan apa pun. */
export async function writeText(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(resolveFsPath(filePath), content, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** Buat direktori (rekursif, semantik `mkdir -p`). `true` bila sukses. */
export async function makeDir(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(resolveFsPath(dirPath), { recursive: true })
    return true
  } catch {
    return false
  }
}

/** True bila path ada (file maupun direktori). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(resolveFsPath(p))
    return true
  } catch {
    return false
  }
}
