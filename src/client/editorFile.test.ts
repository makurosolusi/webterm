import { describe, it, expect } from 'vitest'
import { tooLargeSentinel } from '../shared/fsLimits'
import {
  editorFileKind,
  fileBaseName,
  fileExt,
  isMarkdownExt,
  loadRefusal,
  dirName,
  isUnder,
  remapPath,
  opensInPreview
} from './editorFile'

describe('fileExt / fileBaseName', () => {
  it('mengambil ekstensi lowercase tanpa titik', () => {
    expect(fileExt('/a/b/Main.TSX')).toBe('tsx')
    expect(fileExt('a.tar.gz')).toBe('gz')
  })

  it('dotfile tanpa ekstensi lain dianggap tanpa ekstensi', () => {
    expect(fileExt('/repo/.gitignore')).toBe('')
    expect(fileExt('/repo/Makefile')).toBe('')
  })

  it('backslash dihitung sebagai pemisah path', () => {
    expect(fileBaseName('C:\\tmp\\note.md')).toBe('note.md')
    expect(fileExt('C:\\tmp\\note.md')).toBe('md')
  })
})

describe('editorFileKind (via fileKind WS-00)', () => {
  it('audio/video/archive/biner BUKAN text; markdown tetap text', () => {
    expect(editorFileKind('/x/a.mp3')).toBe('audio')
    expect(editorFileKind('/x/a.MP4')).toBe('video')
    expect(editorFileKind('/x/a.zip')).toBe('archive')
    expect(editorFileKind('/x/a.exe')).toBe('binary')
    expect(editorFileKind('/x/README.md')).toBe('text')
  })
})

describe('editorFileKind', () => {
  it('pdf dapat viewer platform, gambar dapat <img>, sisanya teks', () => {
    expect(editorFileKind('/x/doc.PDF')).toBe('pdf')
    expect(editorFileKind('/x/logo.svg')).toBe('image')
    expect(editorFileKind('/x/main.ts')).toBe('text')
    expect(editorFileKind('/x/README')).toBe('text')
  })

  it('kesembilan ekstensi gambar ikut terpetakan', () => {
    for (const ext of ['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
      expect(editorFileKind(`/x/a.${ext}`)).toBe('image')
  })
})

describe('opensInPreview', () => {
  it('hanya markdown, dan hanya saat setting-nya hidup', () => {
    expect(opensInPreview('md', true)).toBe(true)
    expect(opensInPreview('MARKDOWN', true)).toBe(true)
    expect(opensInPreview('md', false)).toBe(false)
    expect(opensInPreview('ts', true)).toBe(false)
  })

  it('varian markdown dikenali', () => {
    for (const ext of ['md', 'markdown', 'mdown', 'mkd']) expect(isMarkdownExt(ext)).toBe(true)
    expect(isMarkdownExt('mdx')).toBe(false)
  })
})

describe('loadRefusal (gerbang kehilangan data)', () => {
  it('menolak sentinel too-large dan menyebut ukurannya', () => {
    const msg = loadRefusal(tooLargeSentinel(12 * 1024 * 1024), 'File', true)
    expect(msg).toBe('File too large to open here (12.0 MB).')
  })

  it('sentinel ditolak juga untuk gambar/PDF, dengan label masing-masing', () => {
    expect(loadRefusal(tooLargeSentinel(25 * 1024 * 1024), 'PDF')).toContain('PDF too large')
    expect(loadRefusal(tooLargeSentinel(1536), 'Image')).toBe('Image too large to open here (2 KB).')
  })

  it('payload kosong: sah untuk teks, kegagalan baca untuk biner', () => {
    expect(loadRefusal('', 'File', true)).toBeNull()
    expect(loadRefusal('', 'Image')).toBe('Couldn’t read this image.')
  })

  it('payload normal lolos', () => {
    expect(loadRefusal('const a = 1\n', 'File', true)).toBeNull()
    expect(loadRefusal('iVBORw0KGgo=', 'Image')).toBeNull()
  })

  it('isi file yang kebetulan mirip teks sentinel TIDAK ikut ditolak (prefiks NUL)', () => {
    expect(loadRefusal('webterm:too-large:999', 'File', true)).toBeNull()
  })
})

describe('dirName / isUnder / remapPath', () => {
  it('dirName: induk, root, dan tanpa induk', () => {
    expect(dirName('/a/b/c.ts')).toBe('/a/b')
    expect(dirName('/c.ts')).toBe('/')
    expect(dirName('c.ts')).toBe('')
  })

  it('isUnder: sama persis atau di bawah, bukan sekadar prefiks nama', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
    expect(isUnder('/a/b/c.ts', '/a/b/')).toBe(true)
    expect(isUnder('/a/bc/c.ts', '/a/b')).toBe(false)
  })

  it('remapPath: file di-rename, folder induk di-rename, dan tak terdampak', () => {
    expect(remapPath('/a/old.ts', '/a/old.ts', '/a/new.ts')).toBe('/a/new.ts')
    expect(remapPath('/a/dir/x/y.ts', '/a/dir', '/a/renamed')).toBe('/a/renamed/x/y.ts')
    expect(remapPath('/a/dirx/y.ts', '/a/dir', '/a/renamed')).toBeNull()
  })
})
