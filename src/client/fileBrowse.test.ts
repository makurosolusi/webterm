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

const names = (...list: string[]) => list.map((name) => ({ name }))

describe('path helpers', () => {
  it.each([
    ['/srv/app/site', 'site'],
    ['/srv/app/site///', 'site'],
    ['/', '/'],
  ])('folderTitle(%s) is %s', (path, title) => {
    expect(folderTitle(path)).toBe(title)
  })

  it.each([
    ['/x/y/z', '/x/y'],
    ['/x/y/z//', '/x/y'],
    ['/x', '/'],
    ['/', '/'],
    ['~', '/'],
  ])('parentDir(%s) is %s', (path, parent) => {
    expect(parentDir(path)).toBe(parent)
  })

  it.each([
    ['/', 'tmp', '/tmp'],
    ['/x/', 'y', '/x/y'],
    ['/x/y', 'f.log', '/x/y/f.log'],
  ])('childPath(%s, %s) is %s', (dir, name, joined) => {
    expect(childPath(dir, name)).toBe(joined)
  })

  it('createTargetDir picks the folder itself or the file parent', () => {
    expect(createTargetDir('/p/q/readme.md', false)).toBe('/p/q')
    expect(createTargetDir('/p/q', true)).toBe('/p/q')
  })
})

describe('newEntryPath', () => {
  const base = '/work'

  it('trims the typed name and resolves it under the base', () => {
    expect(newEntryPath(base, ' main.go ')).toBe('/work/main.go')
    expect(newEntryPath('/', 'main.go')).toBe('/main.go')
    expect(newEntryPath(base + '/', 'main.go')).toBe('/work/main.go')
  })

  it('accepts nested relative names, dotfiles and leading dots', () => {
    expect(newEntryPath(base, 'one/two/three.txt')).toBe('/work/one/two/three.txt')
    expect(newEntryPath(base, '.gitignore')).toBe('/work/.gitignore')
    expect(newEntryPath(base, '..hidden')).toBe('/work/..hidden')
  })

  it.each(['', '   ', '/abs', '\\abs', 'D:/dir', 'd:file'])('rejects %j as empty or absolute', (typed) => {
    expect(newEntryPath(base, typed)).toBeNull()
  })

  it.each(['..', '../up', 'in/../../up', '..\\up', 'in\\..\\up'])('rejects traversal in %j', (typed) => {
    expect(newEntryPath(base, typed)).toBeNull()
  })

  it.each(['dir/', 'dir\\', 'a//b'])('rejects %j (trailing separator or empty segment)', (typed) => {
    expect(newEntryPath(base, typed)).toBeNull()
  })

  it('treats a mid-name backslash as an ordinary character', () => {
    expect(newEntryPath(base, 'odd\\name')).toBe('/work/odd\\name')
  })

  it('enforces the 255-byte segment limit in bytes, per segment', () => {
    expect(newEntryPath(base, 'z'.repeat(255))).not.toBeNull()
    expect(newEntryPath(base, 'z'.repeat(256))).toBeNull()
    // 3 bytes each: 85 chars = 255 bytes (ok), 86 chars = 258 bytes (too long)
    expect(newEntryPath(base, '€'.repeat(85))).not.toBeNull()
    expect(newEntryPath(base, '€'.repeat(86))).toBeNull()
    expect(newEntryPath(base, `${'q'.repeat(250)}/${'r'.repeat(250)}`)).not.toBeNull()
    expect(newEntryPath(base, `ok/${'q'.repeat(300)}`)).toBeNull()
  })

  it('rejects an embedded NUL', () => {
    expect(newEntryPath(base, 'a\0b')).toBeNull()
  })
})

describe('ancestorDirs', () => {
  it('returns each intermediate directory, outermost first', () => {
    expect(ancestorDirs('/w/', 'p/q/r/file.txt')).toEqual(['/w/p', '/w/p/q', '/w/p/q/r'])
  })

  it('returns nothing for a name without a slash', () => {
    expect(ancestorDirs('/w', 'file.txt')).toEqual([])
  })
})

describe('breadcrumbs', () => {
  it('lists root plus every segment when it fits', () => {
    expect(breadcrumbs('/m/n')).toEqual([
      { name: '/', path: '/' },
      { name: 'm', path: '/m' },
      { name: 'n', path: '/m/n' },
    ])
    expect(breadcrumbs('/k/l/m', 3).map((c) => c.name)).toEqual(['/', 'k', 'l', 'm'])
  })

  it('returns only the root for "/"', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('collapses deep paths into a navigable ellipsis', () => {
    const trail = breadcrumbs('/1/2/3/4/5/6', 2)
    expect(trail.map((c) => c.name)).toEqual(['/', '…', '5', '6'])
    expect(trail[1].path).toBe('/1/2/3/4')
    expect(trail[3].path).toBe('/1/2/3/4/5/6')
  })

  it('honours the default of three trailing segments', () => {
    expect(breadcrumbs('/a/b/c/d').map((c) => c.name)).toEqual(['/', '…', 'b', 'c', 'd'])
  })
})

describe('classifyEmptyListing', () => {
  it('is empty when the parent lists the folder', () => {
    expect(classifyEmptyListing('/p/q', names('other', 'q'))).toBe('empty')
  })

  it('is missing when a populated parent lacks the folder', () => {
    expect(classifyEmptyListing('/p/q', names('other', 'another'))).toBe('missing')
  })

  it('is unreachable when the parent listing is empty or null', () => {
    expect(classifyEmptyListing('/p/q', [])).toBe('unreachable')
    expect(classifyEmptyListing('/p/q', null)).toBe('unreachable')
  })

  it('treats the root (and a slash-only path) as empty with no parent lookup', () => {
    expect(classifyEmptyListing('/', null)).toBe('empty')
    expect(classifyEmptyListing('///', null)).toBe('empty')
  })

  it('matches by name only, so symlinks count as present', () => {
    expect(classifyEmptyListing('/p/ln', [{ name: 'ln', dir: false } as { name: string }])).toBe('empty')
  })

  it('falls back to case-insensitive matching', () => {
    expect(classifyEmptyListing('/p/Docs', names('docs'))).toBe('empty')
  })

  it.each(['~', '~/code', 'rel/path', '/p/.', '/p/..', '/p/.git'])('is unknown for %s', (cwd) => {
    expect(classifyEmptyListing(cwd, names('x'))).toBe('unknown')
  })
})

describe('filterEntries', () => {
  const sample = [{ name: 'Dockerfile' }, { name: 'lib' }, { name: 'tsconfig.json' }]

  it('keeps entries containing the query, ignoring case', () => {
    expect(filterEntries(sample, 'DOCK').map((e) => e.name)).toEqual(['Dockerfile'])
    expect(filterEntries(sample, 'i').map((e) => e.name)).toEqual(['Dockerfile', 'lib', 'tsconfig.json'])
    expect(filterEntries(sample, 'ig.j').map((e) => e.name)).toEqual(['tsconfig.json'])
  })

  it('returns a copy of everything for blank queries', () => {
    const all = filterEntries(sample, '  ')
    expect(all).toEqual(sample)
    expect(all).not.toBe(sample)
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterEntries(sample, 'nope')).toEqual([])
  })
})

describe('open target', () => {
  it.each(['/v/a.MKV', '/v/b.mov', '/m/c.OPUS', '/m/d.aiff'])('%s is media', (p) => {
    expect(isMediaFile(p)).toBe(true)
  })

  it.each(['/v/mkv', '/v/.mp3', '/v/readme.txt', '/'])('%s is not media', (p) => {
    expect(isMediaFile(p)).toBe(false)
  })

  it.each(['/s/app.ts', '/s/Makefile', '/s/.bashrc', '/s/pic.png', '/'])('%s opens in the editor', (p) => {
    expect(opensInEditor(p)).toBe(true)
  })

  it.each(['/d/setup.pkg', '/d/archive.7z', '/d/store.db', '/d/m.wasm', '/d/Tool.app/Contents/readme'])(
    '%s is left to the OS',
    (p) => {
      expect(opensInEditor(p)).toBe(false)
    }
  )

  it('backslash-separated paths are also scanned per segment', () => {
    expect(opensInEditor('C:\\x\\Thing.app\\Info')).toBe(false)
  })

  it('maps files to canvas/os, with media always on the canvas', () => {
    expect(fileOpenTarget('/m/song.mp3')).toBe('canvas')
    expect(fileOpenTarget('/s/app.ts')).toBe('canvas')
    expect(fileOpenTarget('/d/setup.exe')).toBe('os')
    expect(fileOpenTarget('/d/Tool.app/Contents/readme')).toBe('os')
  })
})

describe('childOnPath', () => {
  it('returns the next segment toward the origin', () => {
    expect(childOnPath('/', '/u/v')).toBe('u')
    expect(childOnPath('/u', '/u/v/w')).toBe('v')
    expect(childOnPath('/u/v', '/u/v/w')).toBe('w')
  })

  it.each([
    ['/u/v/w', '/u'],
    ['/u', '/u'],
    ['/other', '/u/v'],
    ['/u', 'u/v'],
  ])('is null for (%s, %s)', (to, from) => {
    expect(childOnPath(to, from)).toBeNull()
  })
})
