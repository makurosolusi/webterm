// Tes pohon file. Dua describe tidak ikut
// karena fungsinya tidak diport (`downloadMenuEntries`, `displacedFilesPatch`); ditambah cakupan
// untuk helper path yang di webterm tinggal di modul yang sama (`newEntryPath`, `ancestorDirs`,
// `createTargetDir`).
import { describe, expect, it } from 'vitest'
import {
  ancestorDirs,
  breadcrumbs,
  childOnPath,
  childPath,
  classifyEmptyListing,
  createTargetDir,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  isMediaFile,
  newEntryPath,
  opensInEditor,
  parentDir,
} from './fileBrowse'

describe('folderTitle', () => {
  it('names the deepest segment', () => {
    expect(folderTitle('/Users/me/src/webterm')).toBe('webterm')
    expect(folderTitle('/Users/me/src/webterm/')).toBe('webterm')
  })

  it('names the root', () => {
    expect(folderTitle('/')).toBe('/')
  })
})

describe('parentDir', () => {
  it('walks up one level', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b')
    expect(parentDir('/a/b/c/')).toBe('/a/b')
  })

  // Naik dari sebuah anak root mendarat di root, dan naik dari root tetap di root — bukan '' yang
  // akan membuat panggilan `fs.list` berikutnya relatif terhadap cwd server.
  it('bottoms out at the root', () => {
    expect(parentDir('/a')).toBe('/')
    expect(parentDir('/')).toBe('/')
  })
})

describe('childPath', () => {
  it('joins without doubling the separator at the root', () => {
    expect(childPath('/a/b', 'c.txt')).toBe('/a/b/c.txt')
    expect(childPath('/', 'etc')).toBe('/etc')
    expect(childPath('/a/', 'b')).toBe('/a/b')
  })
})

describe('createTargetDir', () => {
  it('creates inside a folder, but beside a file', () => {
    expect(createTargetDir('/a/b', true)).toBe('/a/b')
    expect(createTargetDir('/a/b/c.ts', false)).toBe('/a/b')
  })
})

describe('newEntryPath', () => {
  it('appends a simple name', () => {
    expect(newEntryPath('/a/b', 'c.ts')).toBe('/a/b/c.ts')
    expect(newEntryPath('/a/b', '  c.ts  ')).toBe('/a/b/c.ts')
    expect(newEntryPath('/', 'c.ts')).toBe('/c.ts')
  })

  it('allows a nested relative name', () => {
    expect(newEntryPath('/a', 'x/y/z.ts')).toBe('/a/x/y/z.ts')
  })

  it('refuses a NUL byte and a segment over 255 bytes', () => {
    expect(newEntryPath('/a', 'x\0y')).toBeNull()
    expect(newEntryPath('/a', 'a'.repeat(255))).toBe(`/a/${'a'.repeat(255)}`)
    expect(newEntryPath('/a', 'a'.repeat(256))).toBeNull()
    // 86 x 3 byte = 258 byte walau hanya 86 karakter: batasnya byte, bukan panjang string.
    expect(newEntryPath('/a', '€'.repeat(86))).toBeNull()
    expect(newEntryPath('/a', `${'a'.repeat(200)}/${'b'.repeat(200)}`)).not.toBeNull()
  })

  it('refuses empty, absolute and drive-letter names', () => {
    expect(newEntryPath('/a', '')).toBeNull()
    expect(newEntryPath('/a', '   ')).toBeNull()
    expect(newEntryPath('/a', '/etc/passwd')).toBeNull()
    expect(newEntryPath('/a', '\\etc')).toBeNull()
    expect(newEntryPath('/a', 'C:/Windows')).toBeNull()
  })

  // Traversal diperiksa pada kedua separator: `..\x` lolos cek `/` saja lalu baru keluar dari
  // baseDir di filesystem yang mengurai backslash.
  it('refuses traversal on either separator', () => {
    expect(newEntryPath('/a', '../b')).toBeNull()
    expect(newEntryPath('/a', 'x/../../b')).toBeNull()
    expect(newEntryPath('/a', '..\\b')).toBeNull()
  })

  it('refuses a name that ends in a separator or has an empty segment', () => {
    expect(newEntryPath('/a', 'b/')).toBeNull()
    expect(newEntryPath('/a', 'b\\')).toBeNull()
    expect(newEntryPath('/a', 'b//c')).toBeNull()
  })

  // Backslash adalah karakter nama file yang SAH di POSIX, jadi menolaknya akan menolak file nyata.
  it('keeps a lone backslash inside a name', () => {
    expect(newEntryPath('/a', 'we\\ird.ts')).toBe('/a/we\\ird.ts')
  })

  it('allows a dotfile and a name merely starting with dots', () => {
    expect(newEntryPath('/a', '.env')).toBe('/a/.env')
    expect(newEntryPath('/a', '...x')).toBe('/a/...x')
  })
})

describe('ancestorDirs', () => {
  it('lists intermediate directories shallowest first', () => {
    expect(ancestorDirs('/a', 'x/y/z.ts')).toEqual(['/a/x', '/a/x/y'])
  })

  it('is empty for a flat name', () => {
    expect(ancestorDirs('/a', 'z.ts')).toEqual([])
  })
})

describe('breadcrumbs', () => {
  it('starts at the root and walks down', () => {
    expect(breadcrumbs('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
    ])
  })

  it('is just the root for the root', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('keeps the last max segments and collapses the rest', () => {
    const crumbs = breadcrumbs('/a/b/c/d/e', 3)
    expect(crumbs.map((c) => c.name)).toEqual(['/', '…', 'c', 'd', 'e'])
  })

  // Crumb elipsis harus NAVIGABLE — ia menuju direktori tersembunyi terdalam, jadi satu klik
  // membawa pengguna ke dalam bagian path yang diringkas alih-alih melompat ke root.
  it('points the ellipsis at the deepest hidden directory', () => {
    const crumbs = breadcrumbs('/a/b/c/d/e', 3)
    expect(crumbs[1].path).toBe('/a/b')
  })

  it('does not collapse a path that already fits', () => {
    expect(breadcrumbs('/a/b/c', 3).map((c) => c.name)).toEqual(['/', 'a', 'b', 'c'])
  })
})

describe('classifyEmptyListing', () => {
  const entries = (...names: string[]) => names.map((name) => ({ name }))

  it('calls a folder listed by its parent empty', () => {
    expect(classifyEmptyListing('/a/b', entries('b', 'c'))).toBe('empty')
  })

  it('calls a folder absent from a readable parent missing', () => {
    expect(classifyEmptyListing('/a/b', entries('c', 'd'))).toBe('missing')
  })

  // Induk memuat kita, jadi ia tidak mungkin benar-benar tidak-beranak: listing induk yang kosong
  // berarti filesystem-nya yang tidak terjangkau, bukan folder kita yang hilang.
  it('calls an unreadable or empty parent unreachable', () => {
    expect(classifyEmptyListing('/a/b', [])).toBe('unreachable')
    expect(classifyEmptyListing('/a/b', null)).toBe('unreachable')
  })

  it('calls the root empty without asking a parent', () => {
    expect(classifyEmptyListing('/', null)).toBe('empty')
  })

  // Dicocokkan per nama, bukan per `dir`: symlink-ke-direktori terdaftar sebagai entry non-dir.
  it('matches by name, so a symlinked directory is not reported missing', () => {
    expect(classifyEmptyListing('/a/link', entries('link'))).toBe('empty')
  })

  it('accepts a case-folded match on case-insensitive filesystems', () => {
    expect(classifyEmptyListing('/a/Build', entries('build'))).toBe('empty')
  })

  // Bentuk-bentuk path yang listing induknya tidak bisa menjawab. Tanpa cabang ini masing-masing
  // akan gagal cocok-nama dan melaporkan "folder hilang" atas direktori yang terbaca sempurna.
  it('gives up on path shapes no parent listing can answer', () => {
    expect(classifyEmptyListing('~', null)).toBe('unknown')
    expect(classifyEmptyListing('~/src', entries('src'))).toBe('unknown')
    expect(classifyEmptyListing('/a/.', entries('a'))).toBe('unknown')
    expect(classifyEmptyListing('/a/..', entries('a'))).toBe('unknown')
    expect(classifyEmptyListing('/a/.git', entries('x'))).toBe('unknown')
    expect(classifyEmptyListing('relative/dir', entries('dir'))).toBe('unknown')
  })
})

describe('filterEntries', () => {
  const list = [{ name: 'README.md' }, { name: 'src' }, { name: 'package.json' }]

  it('matches a case-insensitive substring', () => {
    expect(filterEntries(list, 'json').map((e) => e.name)).toEqual(['package.json'])
    expect(filterEntries(list, 'READ').map((e) => e.name)).toEqual(['README.md'])
    expect(filterEntries(list, 'ME').map((e) => e.name)).toEqual(['README.md'])
  })

  it('matches everything for an empty or blank query', () => {
    expect(filterEntries(list, '')).toHaveLength(3)
    expect(filterEntries(list, '   ')).toHaveLength(3)
  })

  it('matches nothing when nothing matches', () => {
    expect(filterEntries(list, 'zzz')).toEqual([])
  })
})

describe('isMediaFile / opensInEditor / fileOpenTarget', () => {
  it('recognises video and audio by extension', () => {
    expect(isMediaFile('/a/clip.MP4')).toBe(true)
    expect(isMediaFile('/a/song.flac')).toBe(true)
    expect(isMediaFile('/a/notes.md')).toBe(false)
    expect(isMediaFile('/a/mp4')).toBe(false)
  })

  it('opens text, code and extensionless files in the editor', () => {
    expect(opensInEditor('/a/notes.md')).toBe(true)
    expect(opensInEditor('/a/Makefile')).toBe(true)
    expect(opensInEditor('/a/.env')).toBe(true)
  })

  it('leaves archives, installers and binaries to the OS', () => {
    expect(opensInEditor('/a/app.dmg')).toBe(false)
    expect(opensInEditor('/a/bundle.tar')).toBe(false)
    expect(opensInEditor('/a/data.sqlite')).toBe(false)
  })

  // Setiap segmen diperiksa, bukan hanya basename: sebuah file DI DALAM bundle `.app` juga bukan
  // urusan editor, meski namanya sendiri tampak seperti teks biasa.
  it('checks every path segment, not just the basename', () => {
    expect(opensInEditor('/A/Thing.app/Contents/Info')).toBe(false)
  })

  it('routes media to the canvas even though the OS set contains it', () => {
    expect(fileOpenTarget('/a/clip.mp4')).toBe('canvas')
    expect(fileOpenTarget('/a/notes.md')).toBe('canvas')
    expect(fileOpenTarget('/a/app.dmg')).toBe('os')
  })
})

describe('childOnPath', () => {
  it('names the child leading back toward where we came from', () => {
    expect(childOnPath('/a', '/a/b/c')).toBe('b')
    expect(childOnPath('/a/b', '/a/b/c')).toBe('c')
    expect(childOnPath('/', '/a/b')).toBe('a')
  })

  it('answers null when the target is not a strict ancestor', () => {
    expect(childOnPath('/a/b/c', '/a')).toBeNull()
    expect(childOnPath('/a/b', '/a/b')).toBeNull()
    expect(childOnPath('/x', '/a/b')).toBeNull()
    expect(childOnPath('/a', 'a/b')).toBeNull()
  })
})

