import { describe, expect, it } from 'vitest'
import { fileIconClass, folderIconClass } from './fileIcon'

describe('fileIcon', () => {
  it('memetakan ekstensi ke codicon, case-insensitive, default file', () => {
    expect(fileIconClass('package.json')).toBe('codicon codicon-json')
    expect(fileIconClass('README.MD')).toBe('codicon codicon-markdown')
    expect(fileIconClass('a/b/logo.png')).toBe('codicon codicon-file-media')
    expect(fileIconClass('main.ts')).toBe('codicon codicon-file-code')
    expect(fileIconClass('Makefile')).toBe('codicon codicon-file')
  })
  it('folder terbuka vs tertutup', () => {
    expect(folderIconClass(false)).toBe('codicon codicon-folder')
    expect(folderIconClass(true)).toBe('codicon codicon-folder-opened')
  })
})
