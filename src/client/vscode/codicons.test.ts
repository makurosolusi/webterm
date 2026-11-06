/** @vitest-environment jsdom */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CODICON_STYLESHEET_ID, installCodicons } from './codicons'

// test-only: worktree ini memakai node_modules symlink di luar root Vite (fs.deny menolak `?url`); di repo biasa tak perlu.
vi.mock('@vscode/codicons/dist/codicon.css?url', () => ({ default: '/codicon.css' }))

// jsdom menulis ulang import.meta.url ke http: resolusi dari cwd (root vitest `src/client` atau root repo).
const themeDir = ['vscode', 'src/client/vscode'].map((f) => path.resolve(f)).find((f) => existsSync(path.join(f, 'vscode-theme.css')))!
// Palet dipecah dark + light (urutan impor = urutan cascade); gabungkan agar asersi tetap membaca seluruh token.
const theme = ['dark', 'light'].map((part) => readFileSync(path.join(themeDir, `vscode-theme.${part}.css`), 'utf8')).join('\n')
const light = theme.slice(theme.indexOf("[data-theme='light']"))
const dark = theme.slice(0, theme.indexOf("[data-theme='light']"))

describe('installCodicons', () => {
  it('adds one stylesheet link under the id <vscode-icon> looks for, and is idempotent', () => {
    const a = installCodicons(document)
    const b = installCodicons(document)
    expect(a).toBe(b)
    expect(a.id).toBe(CODICON_STYLESHEET_ID)
    expect(a.rel).toBe('stylesheet')
    expect(document.querySelectorAll(`#${CODICON_STYLESHEET_ID}`)).toHaveLength(1)
  })

  it('lands before the app stylesheets so equal-specificity chrome sizes (24px activity icon) win', () => {
    const doc = document.implementation.createHTMLDocument('t')
    doc.head.appendChild(doc.createElement('style'))
    const link = installCodicons(doc)
    expect(doc.head.firstElementChild).toBe(link)
  })
})

// Monaco membawa codicon.css-nya sendiri (`.codicon[class*='codicon-'] { font: 16px/1 codicon }`) di chunk
// malasnya; Vite menyisipkannya PALING BELAKANG di <head> saat node editor pertama mount, setelah sheet chrome.
const fromRoot = (rel: string) => [path.resolve(rel), path.resolve('../..', rel)].find(existsSync)!
const read = (rel: string) => readFileSync(fromRoot(rel), 'utf8')

describe('chrome codicon sizes vs Monaco codicon.css loaded last', () => {
  it.each([
    ['src/client/components/vscode/vscode-shell.css', 'vscode-activity-bar__icon', 'var(--activity-icon-size, 24px)'],
    ['src/client/dock.css', 'dock-menu__check', '13px'],
    ['src/client/filesSlot.git.css', 'files-git-foot', '12px'],
  ])('%s keeps .%s icons at %s', (sheet, parent, size) => {
    // getComputedStyle hanya membaca sheet milik `document` global, bukan dokumen buatan createHTMLDocument.
    const styles = [
      read('node_modules/@vscode/codicons/dist/codicon.css'), // installCodicons: first in <head>
      read(sheet),
      read('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'), // lazy, last
    ].map((css) => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css })))
    const host = Object.assign(document.createElement('span'), { className: parent })
    host.innerHTML = '<span class="codicon codicon-check"></span>'
    document.body.appendChild(host)
    try {
      expect(getComputedStyle(host.firstElementChild!).fontSize).toBe(size)
    } finally {
      for (const el of [...styles, host]) el.remove()
    }
  })
})

describe('vscode-theme.css palette', () => {
  it('carries the official Dark Modern values', () => {
    for (const tok of [
      '--vscode-editor-background: #1f1f1f',
      '--vscode-sideBar-background: #181818',
      '--vscode-focusBorder: #0078d4',
    ]) expect(dark).toContain(tok)
  })

  it('carries the official Light Modern values', () => {
    for (const tok of [
      '--vscode-editor-background: #ffffff',
      '--vscode-sideBar-background: #f8f8f8',
      '--vscode-focusBorder: #005fb8',
    ]) expect(light).toContain(tok)
  })
})
