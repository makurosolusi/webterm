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
  it('nama khusus menang atas ekstensi; package.json/README tetap dari ekstensi', () => {
    expect(fileIconClass('bun.lock')).toBe('codicon codicon-lock')
    expect(fileIconClass('/p/Package-Lock.json')).toBe('codicon codicon-lock')
    expect(fileIconClass('.gitignore')).toBe('codicon codicon-source-control')
    expect(fileIconClass('.env.local')).toBe('codicon codicon-key')
    expect(fileIconClass('Dockerfile')).toBe('codicon codicon-server-environment')
    expect(fileIconClass('tsconfig.json')).toBe('codicon codicon-settings-gear')
    expect(fileIconClass('package.json')).toBe('codicon codicon-json')
    expect(fileIconClass('.environment')).toBe('codicon codicon-file')
  })
  it('folder terbuka vs tertutup', () => {
    expect(folderIconClass(false)).toBe('codicon codicon-folder')
    expect(folderIconClass(true)).toBe('codicon codicon-folder-opened')
  })
})
