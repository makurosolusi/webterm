import { describe, it, expect } from 'vitest'
import { tooLargeSentinel } from '../shared/fsLimits'
import {
  dirName,
  editorFileKind,
  fileBaseName,
  fileExt,
  isMarkdownExt,
  isUnder,
  loadRefusal,
  opensInPreview,
  remapPath,
} from './editorFile'

describe('fileBaseName and fileExt', () => {
  it('takes the last segment and a lowercase extension without the dot', () => {
    expect(fileBaseName('/srv/app/Index.HTML')).toBe('Index.HTML')
    expect(fileExt('/srv/app/Index.HTML')).toBe('html')
    expect(fileExt('backup.2024.tar.gz')).toBe('gz')
  })

  it('treats dotfiles and extensionless names as having no extension', () => {
    expect(fileExt('/home/u/.bashrc')).toBe('')
    expect(fileExt('/home/u/Dockerfile')).toBe('')
    expect(fileExt('/home/u/dir/')).toBe('')
  })

  it('handles backslash separators', () => {
    expect(fileBaseName('D:\\work\\todo.txt')).toBe('todo.txt')
    expect(fileExt('D:\\work\\todo.txt')).toBe('txt')
  })

  it('returns an empty basename for an empty path', () => {
    expect(fileBaseName('')).toBe('')
  })
})

describe('editorFileKind', () => {
  it.each([
    ['/m/song.mp3', 'audio'],
    ['/m/clip.MP4', 'video'],
    ['/m/pack.zip', 'archive'],
    ['/m/tool.exe', 'binary'],
    ['/m/paper.PDF', 'pdf'],
    ['/m/icon.svg', 'image'],
    ['/m/app.ts', 'text'],
    ['/m/LICENSE', 'text'],
  ])('maps %s to %s', (path, kind) => {
    expect(editorFileKind(path)).toBe(kind)
  })

  it('shows Markdown in the text editor', () => {
    expect(editorFileKind('/m/notes.md')).toBe('text')
  })

  it.each(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])('treats .%s as an image', (ext) => {
    expect(editorFileKind(`/m/pic.${ext}`)).toBe('image')
  })
})

describe('Markdown preview decision', () => {
  it('previews Markdown only, and only when the setting is on', () => {
    expect(opensInPreview('md', true)).toBe(true)
    expect(opensInPreview('Markdown', true)).toBe(true)
    expect(opensInPreview('md', false)).toBe(false)
    expect(opensInPreview('json', true)).toBe(false)
    expect(opensInPreview('', true)).toBe(false)
  })

  it('knows the Markdown extensions and not look-alikes', () => {
    for (const ext of ['md', 'MD', 'markdown', 'mdown', 'mkd']) expect(isMarkdownExt(ext)).toBe(true)
    for (const ext of ['mdx', 'txt', 'm', '']) expect(isMarkdownExt(ext)).toBe(false)
  })
})

describe('loadRefusal: the data-loss gate', () => {
  it('refuses a too-large sentinel and names the size', () => {
    expect(loadRefusal(tooLargeSentinel(3 * 1024 * 1024), 'File', true)).toBe('File too large to open here (3.0 MB).')
  })

  it('refuses it for binary kinds too, with the caller label', () => {
    expect(loadRefusal(tooLargeSentinel(40 * 1024 * 1024), 'PDF')).toMatch(/^PDF too large/)
    expect(loadRefusal(tooLargeSentinel(2048), 'Image')).toBe('Image too large to open here (2 KB).')
  })

  it('accepts an empty text payload but reports a failed read for an empty binary one', () => {
    expect(loadRefusal('', 'File', true)).toBeNull()
    expect(loadRefusal('', 'PDF')).toBe('Couldn’t read this pdf.')
  })

  it('lets ordinary payloads through', () => {
    expect(loadRefusal('hello\n', 'File', true)).toBeNull()
    expect(loadRefusal('R0lGODlhAQABAAAAACw=', 'Image')).toBeNull()
  })

  it('does not mistake file content that spells the sentinel text for the sentinel', () => {
    expect(loadRefusal('webterm:too-large:12345', 'File', true)).toBeNull()
  })
})

describe('path arithmetic', () => {
  it('dirName gives the parent, the root for a root child, or nothing', () => {
    expect(dirName('/var/log/syslog')).toBe('/var/log')
    expect(dirName('/boot')).toBe('/')
    expect(dirName('boot')).toBe('')
    expect(dirName('D:\\a\\b.txt')).toBe('D:/a')
  })

  it('isUnder matches the root itself and descendants, not name prefixes', () => {
    expect(isUnder('/w/proj', '/w/proj')).toBe(true)
    expect(isUnder('/w/proj/src/a.ts', '/w/proj/')).toBe(true)
    expect(isUnder('/w/project/a.ts', '/w/proj')).toBe(false)
    expect(isUnder('/w', '/w/proj')).toBe(false)
  })

  it('remapPath rewrites renamed files and folders and skips unrelated paths', () => {
    expect(remapPath('/w/a.txt', '/w/a.txt', '/w/b.txt')).toBe('/w/b.txt')
    expect(remapPath('/w/docs/x/y.md', '/w/docs', '/w/guide')).toBe('/w/guide/x/y.md')
    expect(remapPath('/w/docs/x.md', '/w/docs/', '/w/guide/')).toBe('/w/guide/x.md')
    expect(remapPath('/w/docs2/x.md', '/w/docs', '/w/guide')).toBeNull()
  })
})
