import { describe, it, expect } from 'vitest'
import { tooLargeSentinel } from '../shared/fsLimits'
import {
  IMAGE_MIME,
  base64ToBytes,
  editorFileKind,
  fileBaseName,
  fileExt,
  isMarkdownExt,
  loadRefusal,
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

describe('editorFileKind', () => {
  it('pdf dapat viewer platform, gambar dapat <img>, sisanya teks', () => {
    expect(editorFileKind('/x/doc.PDF')).toBe('pdf')
    expect(editorFileKind('/x/logo.svg')).toBe('image')
    expect(editorFileKind('/x/main.ts')).toBe('text')
    expect(editorFileKind('/x/README')).toBe('text')
  })

  it('kesembilan ekstensi gambar nodeterm ikut terpetakan', () => {
    expect(Object.keys(IMAGE_MIME).sort()).toEqual(
      ['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']
    )
    for (const ext of Object.keys(IMAGE_MIME)) expect(editorFileKind(`/x/a.${ext}`)).toBe('image')
  })
})

describe('opensInPreview', () => {
  it('hanya markdown, dan hanya saat setting-nya hidup', () => {
    expect(opensInPreview('md', true)).toBe(true)
    expect(opensInPreview('MARKDOWN', true)).toBe(true)
    expect(opensInPreview('md', false)).toBe(false)
    expect(opensInPreview('ts', true)).toBe(false)
  })

  it('varian markdown nodeterm dikenali', () => {
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
    expect(loadRefusal('nodeterm:too-large:999', 'File', true)).toBeNull()
  })
})

describe('base64ToBytes', () => {
  it('mempertahankan byte di atas 0x7f apa adanya (UTF-8 akan merusak PDF)', () => {
    // '%PDF-' lalu 0xff 0x80 0x00 — rangkaian yang justru akan diubah TextEncoder.
    const bytes = base64ToBytes(btoa('%PDF-\xff\x80\x00'))
    expect(bytes && [...bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x80, 0x00])
  })

  it('null untuk base64 cacat, bukan melempar', () => {
    expect(base64ToBytes('!!! bukan base64 !!!')).toBeNull()
  })

  it('base64 kosong jadi nol byte', () => {
    expect(base64ToBytes('')?.length).toBe(0)
  })
})
